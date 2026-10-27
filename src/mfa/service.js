'use strict';
const {verifyPassword}=require('../security/password');
const {matchTotp,decryptSecret,encryptSecret,recoveryCodes,normalizedRecovery,hashRecovery}=require('./crypto');
// Development-only replay tracking. Multi-instance deployment requires a shared durable store.
const usedTotpSteps=new Map();
function claimTotpStep(userId,step){
  const now=Date.now();if(usedTotpSteps.size>2000)for(const [k,v] of usedTotpSteps)if(now-v.at>180000)usedTotpSteps.delete(k);
  const id=String(userId);const old=usedTotpSteps.get(id);
  if(old&&old.step>=step)return false;
  usedTotpSteps.set(id,{step,at:now});return true;
}

async function mfaState(pool,userId){
 const rs=await pool.query('SELECT "User_ID","Email","Password_Hash","Two_Factor_Enabled","Two_Factor_Secret_Encrypted" FROM sdc."USER" WHERE "User_ID"=$1',[userId]);
 return rs.rowCount===1?rs.rows[0]:null;
}
async function checkSecondFactor(pool,userId,code,{consume=true}={}){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const rs=await c.query('SELECT "Two_Factor_Enabled","Two_Factor_Secret_Encrypted" FROM sdc."USER" WHERE "User_ID"=$1 FOR UPDATE',[userId]);
  if(rs.rowCount!==1||rs.rows[0].Two_Factor_Enabled!==true){await c.query('ROLLBACK');return {ok:false};}
  const supplied=typeof code==='string'?code.trim():'';
  let matchedStep=null;
  if(/^[0-9]{6}$/.test(supplied)){
   matchedStep=matchTotp(decryptSecret(rs.rows[0].Two_Factor_Secret_Encrypted),supplied);
   if(matchedStep===null){await c.query('ROLLBACK');return {ok:false};}
  } else {
   const canonical=normalizedRecovery(supplied);
   if(!canonical){await c.query('ROLLBACK');return {ok:false};}
   const hash=hashRecovery(userId,canonical);
   const r=await c.query('UPDATE sdc."USER_RECOVERY_CODES" SET "Used_At"=LOCALTIMESTAMP WHERE "User_ID"=$1 AND "Code_Hash"=$2 AND "Used_At" IS NULL RETURNING "Code_Hash"',[userId,hash]);
   if(r.rowCount!==1){await c.query('ROLLBACK');return {ok:false};}
   await c.query("SELECT set_config('sdc.user_id',$1,true)",[String(userId)]);
   await c.query(`INSERT INTO sdc."AUDIT_LOG" ("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES (LOCALTIMESTAMP,'account.mfa.recovery.used','User',$1,'استخدام رمز استرداد للتحقق الثنائي',$2)`,[String(userId),userId]);
  }
  if(matchedStep!==null&&!claimTotpStep(userId,matchedStep)){await c.query('ROLLBACK');return {ok:false};}
  if(consume)await c.query('COMMIT');else await c.query('ROLLBACK');
  return {ok:true,step:matchedStep,recovery:matchedStep===null};
 }catch(error){try{await c.query('ROLLBACK');}catch{}throw error;}finally{c.release();}
}
async function enableMfa(pool,userId,secret){
 const encrypted=encryptSecret(secret),codes=recoveryCodes();const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SELECT set_config('sdc.user_id',$1,true)",[String(userId)]);
  const changed=await c.query('UPDATE sdc."USER" SET "Two_Factor_Enabled"=true,"Two_Factor_Secret_Encrypted"=$2 WHERE "User_ID"=$1 AND "Two_Factor_Enabled"=false RETURNING "User_ID"',[userId,encrypted]);
  if(changed.rowCount!==1){await c.query('ROLLBACK');return {ok:false};}
  for(const code of codes)await c.query('INSERT INTO sdc."USER_RECOVERY_CODES"("Code_Hash","User_ID") VALUES ($1,$2)',[hashRecovery(userId,code),userId]);
  await c.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES (LOCALTIMESTAMP,'account.mfa.enabled','User',$1,'تفعيل التحقق الثنائي',$2)`,[String(userId),userId]);
  await c.query('COMMIT');return {ok:true,codes};
 }catch(error){try{await c.query('ROLLBACK');}catch{}throw error;}finally{c.release();}
}
async function disableMfa(pool,userId,password,code){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SELECT set_config('sdc.user_id',$1,true)",[String(userId)]);
  const result=await c.query('SELECT "Password_Hash","Two_Factor_Enabled","Two_Factor_Secret_Encrypted" FROM sdc."USER" WHERE "User_ID"=$1 FOR UPDATE',[userId]);
  if(result.rowCount!==1||result.rows[0].Two_Factor_Enabled!==true||typeof password!=='string'||!await verifyPassword(password,result.rows[0].Password_Hash)){await c.query('ROLLBACK');return false;}
  let success=false;const supplied=typeof code==='string'?code.trim():'';
  if(/^[0-9]{6}$/.test(supplied))success=matchTotp(decryptSecret(result.rows[0].Two_Factor_Secret_Encrypted),supplied)!==null;
  else {const canonical=normalizedRecovery(supplied);if(canonical){const r=await c.query('SELECT 1 FROM sdc."USER_RECOVERY_CODES" WHERE "User_ID"=$1 AND "Code_Hash"=$2 AND "Used_At" IS NULL',[userId,hashRecovery(userId,canonical)]);success=r.rowCount===1;}}
  if(!success){await c.query('ROLLBACK');return false;}
  await c.query('UPDATE sdc."USER" SET "Two_Factor_Enabled"=false,"Two_Factor_Secret_Encrypted"=NULL WHERE "User_ID"=$1',[userId]);
  await c.query('DELETE FROM sdc."USER_RECOVERY_CODES" WHERE "User_ID"=$1',[userId]);
  await c.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES (LOCALTIMESTAMP,'account.mfa.disabled','User',$1,'تعطيل التحقق الثنائي',$2)`,[String(userId),userId]);
  await c.query('COMMIT');return true;
 }catch(error){try{await c.query('ROLLBACK');}catch{}throw error;}finally{c.release();}
}
module.exports={mfaState,checkSecondFactor,enableMfa,disableMfa};
