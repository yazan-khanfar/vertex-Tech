'use strict';
const crypto=require('node:crypto');
const {hashPassword,verifyPassword}=require('../security/password');
const {revokeUserSessions}=require('../auth/session');
const {deliver,config}=require('./delivery');
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_VALIDITY_MINUTES=30;
function normalizeEmail(value){return typeof value==='string'?value.trim().toLowerCase():'';}
function validPassword(value){return typeof value==='string'&&value.length>=14&&value.length<=128&&/[a-z]/i.test(value)&&/[0-9]/.test(value)&&/[^A-Za-z0-9]/.test(value)&&!/[\u0000-\u001f]/.test(value);}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex');}
function validToken(token){return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token);}

async function requestReset(pool,rawEmail,{sender=deliver}={}){
  // Fail closed: do not store unusable reset tokens if email delivery is unconfigured.
  config();
  const email=normalizeEmail(rawEmail);
  if(!EMAIL.test(email)||email.length>254)return;
  const found=await pool.query(`SELECT "User_ID","Email" FROM sdc."USER" WHERE lower(btrim("Email"))=$1 AND "Password_Hash" IS NOT NULL`,[email]);
  if(found.rowCount!==1)return; // response is indistinguishable to the user
  const user=found.rows[0];
  const token=crypto.randomBytes(32).toString('hex'),hashed=tokenHash(token);
  await pool.query(`UPDATE sdc."USER" SET "Password_Reset_Token_Hash"=$2,
    "Password_Reset_Expires_At"=timezone('UTC',now()) + interval '30 minutes'
    WHERE "User_ID"=$1`,[user.User_ID,hashed]);
  try{await sender(user.Email,token);}catch(error){
    // Don't leave live credentials that weren't successfully delivered.
    await pool.query(`UPDATE sdc."USER" SET "Password_Reset_Token_Hash"=NULL,
      "Password_Reset_Expires_At"=NULL WHERE "User_ID"=$1 AND "Password_Reset_Token_Hash"=$2`,[user.User_ID,hashed]);
    throw error;
  }
}
async function isValidReset(pool,token){
  if(!validToken(token))return false;
  const rs=await pool.query(`SELECT 1 FROM sdc."USER" WHERE "Password_Reset_Token_Hash"=$1
    AND "Password_Reset_Expires_At">timezone('UTC',now()) LIMIT 1`,[tokenHash(token)]);
  return rs.rowCount===1;
}
async function revokeDbSessions(c,userId){
  await c.query(`UPDATE sdc."USER_SESSIONS" SET "Revoked_At"=GREATEST("Started_At",LOCALTIMESTAMP)
    WHERE "User_ID"=$1 AND "Revoked_At" IS NULL`,[userId]);
}
async function resetPassword(pool,token,newPassword){
  if(!validToken(token)||!validPassword(newPassword))return false;
  const client=await pool.connect();let userId;
  try{
    await client.query('BEGIN');
    const found=await client.query(`SELECT "User_ID","Password_Hash" FROM sdc."USER"
      WHERE "Password_Reset_Token_Hash"=$1 AND "Password_Reset_Expires_At">timezone('UTC',now()) FOR UPDATE`,[tokenHash(token)]);
    if(found.rowCount!==1){await client.query('ROLLBACK');return false;}
    userId=String(found.rows[0].User_ID);
    if(found.rows[0].Password_Hash&&await verifyPassword(newPassword,found.rows[0].Password_Hash)){
      await client.query('ROLLBACK');return false;
    }
    const hash=await hashPassword(newPassword);
    const changed=await client.query(`UPDATE sdc."USER" SET "Password_Hash"=$2,
      "Password_Reset_Token_Hash"=NULL,"Password_Reset_Expires_At"=NULL
      WHERE "User_ID"=$1 AND "Password_Reset_Token_Hash"=$3 RETURNING "User_ID"`,[userId,hash,tokenHash(token)]);
    if(changed.rowCount!==1){await client.query('ROLLBACK');return false;}
    await revokeDbSessions(client,userId);
    // Reset proves possession of the emailed token, not the logged-in identity; don't attribute actor falsely.
    await client.query(`INSERT INTO sdc."AUDIT_LOG" ("Occurred_At","Action_Type","Target_Type","Target_Reference","Description")
      VALUES (LOCALTIMESTAMP,'account.password.reset','User',$1,'تغيير كلمة المرور عبر رابط الاستعادة')`,[userId]);
    await client.query('COMMIT');
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
  revokeUserSessions(userId); // Also invalidate pending MFA challenges and local sessions.
  return true;
}
async function changePassword(pool,userId,oldPassword,newPassword){
  if(!/^[1-9]\d{0,18}$/.test(String(userId))||typeof oldPassword!=='string'||!validPassword(newPassword))return false;
  let phase='database connection';
  const client=await pool.connect();
  try{
    phase='BEGIN';
    await client.query('BEGIN');
    phase='set authenticated actor';
    await client.query("SELECT set_config('sdc.user_id',$1,true)",[String(userId)]);
    phase='lock account';
    const found=await client.query(`SELECT "Password_Hash" FROM sdc."USER" WHERE "User_ID"=$1 FOR UPDATE`,[userId]);
    phase='verify current and new passwords';
    if(found.rowCount!==1||!found.rows[0].Password_Hash||
      !await verifyPassword(oldPassword,found.rows[0].Password_Hash)||
      await verifyPassword(newPassword,found.rows[0].Password_Hash)){
      await client.query('ROLLBACK');return false;
    }
    phase='hash new password';
    const newHash=await hashPassword(newPassword);
    phase='update account';
    const updated=await client.query(`UPDATE sdc."USER" SET "Password_Hash"=$2,
      "Password_Reset_Token_Hash"=NULL,"Password_Reset_Expires_At"=NULL WHERE "User_ID"=$1`,[userId,newHash]);
    if(updated.rowCount!==1)throw Object.assign(new Error('Expected exactly one account row to be updated'),{code:'ACCOUNT_UPDATE_COUNT'});
    phase='revoke database sessions';
    await revokeDbSessions(client,userId);
    phase='write audit event';
    // Different PostgreSQL column types need independently typed bind parameters.
    // Do not reuse $1 for both VARCHAR(512) Target_Reference and BIGINT User_ID
    // (PostgreSQL raises 42P08: ambiguous_parameter).
    await client.query(`INSERT INTO sdc."AUDIT_LOG" ("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID")
      VALUES (LOCALTIMESTAMP,'account.password.changed','User',$1::varchar(512),'تغيير كلمة المرور من إعدادات الحساب',$2::bigint)`,[String(userId),String(userId)]);
    phase='COMMIT (includes deferred PostgreSQL constraints)';
    await client.query('COMMIT');
  }catch(error){
    // This is a transaction failure, not a current-password mismatch.
    // Attach the failing stage; never attach plaintext password or SQL parameters.
    if(error && typeof error==='object')error.passwordChangePhase=phase;
    try{await client.query('ROLLBACK');}catch{}
    throw error;
  }finally{client.release();}
  revokeUserSessions(userId);
  return true;
}

module.exports={validPassword,validToken,tokenHash,requestReset,isValidReset,resetPassword,changePassword,RESET_VALIDITY_MINUTES};
