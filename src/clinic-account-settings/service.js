'use strict';
const {verifyPassword}=require('../security/password');
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRe=/^[+0-9()\s-]{7,30}$/;
function contactFromBody(body){
 const email=String(body?.email||'').trim().toLowerCase();
 const phone=String(body?.phone||'').trim();
 if(email.length<5||email.length>254||!emailRe.test(email)||phone.length>30||!phoneRe.test(phone)||phone.replace(/\D/g,'').length<6)return null;
 return {email,phone};
}
function preferredLanguage(lang){return ['ar','en'].includes(lang)?lang:null;}
async function loadAccount(pool,userId){
 const r=await pool.query('SELECT "User_ID","Email","Phone","Preferred_Language" FROM sdc."USER" WHERE "User_ID"=$1::bigint AND "Account_Status"=\'active\'',[userId]);
 return r.rows[0]||null;
}
async function changeContact(pool,userId,body){
 const input=contactFromBody(body);if(!input||typeof body?.password!=='string'||!body.password)return {status:'invalid'};
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SELECT set_config('sdc.user_id',$1::text,true)",[String(userId)]);
  const result=await db.query('SELECT "Password_Hash","Email","Phone" FROM sdc."USER" WHERE "User_ID"=$1::bigint AND "Account_Status"=\'active\' FOR UPDATE',[userId]);
  if(!result.rowCount){await db.query('ROLLBACK');return {status:'not_found'};}
  if(!await verifyPassword(body.password,result.rows[0].Password_Hash)){
   await db.query('ROLLBACK');return {status:'password'};
  }
  if(result.rows[0].Email!==input.email){
   const exists=await db.query('SELECT 1 FROM sdc."USER" WHERE lower("Email")=lower($1::varchar(254)) AND "User_ID"<>$2::bigint LIMIT 1',[input.email,userId]);
   if(exists.rowCount){await db.query('ROLLBACK');return {status:'duplicate'};}
  }
  await db.query('UPDATE sdc."USER" SET "Email"=$2::varchar(254),"Phone"=$3::varchar(30) WHERE "User_ID"=$1::bigint',[userId,input.email,input.phone]);
  await db.query(`INSERT INTO sdc."AUDIT_LOG" ("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES (LOCALTIMESTAMP,'account.contact.updated','User',$1::varchar(512),'تعديل بيانات تسجيل الدخول من إعدادات الحساب',$2::bigint)`,[String(userId),userId]);
  await db.query('COMMIT');return {status:'ok'};
 }catch(err){try{await db.query('ROLLBACK');}catch{};if(err.code==='23505')return {status:'duplicate'};throw err;}finally{db.release();}
}
async function changeLanguage(pool,userId,lang){
 const language=preferredLanguage(lang);if(!language)return {status:'invalid'};
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SELECT set_config('sdc.user_id',$1::text,true)",[String(userId)]);
  const changed=await db.query('UPDATE sdc."USER" SET "Preferred_Language"=$2::varchar(10) WHERE "User_ID"=$1::bigint AND "Account_Status"=\'active\'',[userId,language]);
  if(!changed.rowCount){await db.query('ROLLBACK');return {status:'not_found'};}
  await db.query(`INSERT INTO sdc."AUDIT_LOG" ("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES (LOCALTIMESTAMP,'account.language.updated','User',$1::varchar(512),'تعديل اللغة المفضلة للحساب',$2::bigint)`,[String(userId),userId]);
  await db.query('COMMIT');return {status:'ok'};
 }catch(err){try{await db.query('ROLLBACK');}catch{};throw err;}finally{db.release();}
}
module.exports={contactFromBody,preferredLanguage,loadAccount,changeContact,changeLanguage};
