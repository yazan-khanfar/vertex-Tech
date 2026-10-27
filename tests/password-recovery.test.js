'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {hashPassword,verifyPassword}=require('../src/security/password');
const {validPassword,validToken,requestReset,isValidReset,resetPassword,changePassword,tokenHash}=require('../src/password-reset/service');
const {createSession,getSession}=require('../src/auth/session');
const STRONG='New-Strong-Password-2026!';
const old='Old-Strong-Password-2026!';
test('password strength and token validation',()=>{
 assert(validPassword(STRONG));assert(!validPassword('short'));assert(!validPassword('a'.repeat(20)));
 assert(validToken('a'.repeat(64)));assert(!validToken('a'.repeat(63)));
 assert.equal(tokenHash('abc').length,64);
});
test('reset request saves SHA-256 hash, sends token once and reveals no account information',async()=>{
 const oldMode=process.env.PASSWORD_RESET_DELIVERY;
 process.env.PASSWORD_RESET_DELIVERY='console';
 const writes=[];let delivered=null;
 const pool={async query(sql,args){writes.push({sql,args});
  if(sql.includes('SELECT "User_ID"'))return {rowCount:1,rows:[{User_ID:3,Email:'doctor@example.invalid'}]};
  return {rowCount:1,rows:[]};}};
 try{
  await requestReset(pool,'DOCTOR@EXAMPLE.INVALID',{sender:async(email,token)=>{delivered={email,token};}});
  assert.equal(delivered.email,'doctor@example.invalid');
  assert(validToken(delivered.token));
  assert.equal(writes[1].args[1],tokenHash(delivered.token));
  assert(!writes[1].args.includes(delivered.token));
  const poolUnknown={query:async()=>({rowCount:0,rows:[]})};
  await requestReset(poolUnknown,'none@example.invalid',{sender:async()=>{throw Error('must not send');}});
 }finally{if(oldMode===undefined)delete process.env.PASSWORD_RESET_DELIVERY;else process.env.PASSWORD_RESET_DELIVERY=oldMode;}
});
test('recovery resets password in transaction, clears token, revokes sessions, does not change MFA',async()=>{
 const oldHash=await hashPassword(old);
 const queryEvents=[];let committed=false;const userId='3';
 const response={append:(_name,cookie)=>{response.cookie=cookie;}};
 createSession(response,{userId,role:'doctor',mfaVerified:true});
 const req={headers:{cookie:response.cookie.split(';')[0]}};
 assert(getSession(req));
 const client={async query(sql,args){queryEvents.push({sql,args});
    if(sql.includes('SELECT "User_ID","Password_Hash"'))return {rowCount:1,rows:[{User_ID:3,Password_Hash:oldHash}]};
    if(sql.startsWith('UPDATE sdc."USER"'))return {rowCount:1};
    if(sql==='COMMIT')committed=true;
    return {rowCount:1,rows:[]};
 },release(){}};
 const pool={connect:async()=>client};
 assert.equal(await resetPassword(pool,'a'.repeat(64),STRONG),true);
 assert(committed);
 assert.equal(getSession(req),null);
 assert(queryEvents.some(x=>x.sql.includes('"Password_Reset_Token_Hash"=NULL')));
 assert(queryEvents.some(x=>x.sql.includes('UPDATE sdc."USER_SESSIONS"')));
 assert(queryEvents.every(x=>!x.sql.includes('"Two_Factor_Enabled"=')));
 assert(queryEvents.some(x=>x.sql.includes('account.password.reset')));
 assert.equal((await verifyPassword(STRONG,queryEvents.find(x=>x.sql.startsWith('UPDATE sdc."USER"')).args[1])),true);
});
test('used or expired reset tokens cannot change password and rollback',async()=>{
 const queries=[];
 const client={async query(sql){queries.push(sql);if(sql.includes('FOR UPDATE'))return {rowCount:0,rows:[]};return {rowCount:1};},release(){}};
 assert.equal(await resetPassword({connect:async()=>client},'a'.repeat(64),STRONG),false);
 assert(queries.includes('ROLLBACK'));
 assert(!queries.some(s=>s.startsWith('UPDATE sdc."USER"')));
});
test('change requires current password and revokes sessions after success',async()=>{
 const hash=await hashPassword(old),history=[];
 let committed=false;
 const client={async query(sql,args){history.push({sql,args});
  if(sql.includes('SELECT "Password_Hash"'))return {rowCount:1,rows:[{Password_Hash:hash}]};
  if(sql==='COMMIT')committed=true;
  return {rowCount:1,rows:[]};
 },release(){}};
 const pool={connect:async()=>client};
 assert.equal(await changePassword(pool,'3','wrong password',STRONG),false);
 assert(history.some(x=>x.sql==='ROLLBACK'));
 history.length=0;
 assert.equal(await changePassword(pool,'3',old,STRONG),true);
 assert(committed);
 assert(history.some(x=>x.sql.includes('account.password.changed')));
 assert(history.some(x=>x.sql.includes('SET "Revoked_At"')));
});

test('password change audit SQL binds text reference and bigint actor separately (42P08 regression)',async()=>{
 const oldHash=await hashPassword(old);
 let audited=false;
 const client={async query(sql,args){
   if(sql.includes('SELECT "Password_Hash"'))return {rowCount:1,rows:[{Password_Hash:oldHash}]};
   if(sql.startsWith('INSERT INTO sdc."AUDIT_LOG"')){
     audited=true;
     assert.match(sql,/\$1::varchar\(512\)/);
     assert.match(sql,/\$2::bigint/);
     assert.deepEqual(args,['3','3']);
     assert(!/Description[^`]*?\$1\)/.test(sql));
   }
   return {rowCount:1,rows:[]};
 },release(){}};
 assert.equal(await changePassword({connect:async()=>client},'3',old,STRONG),true);
 assert(audited,'audit insert must be executed before transaction commit');
});

test('change password reports failed database stage without exposing password values',async()=>{
 const oldHash=await hashPassword(old);
 const calls=[];
 const client={async query(sql){
   calls.push(sql);
   if(sql.includes('SELECT "Password_Hash"'))return {rowCount:1,rows:[{Password_Hash:oldHash}]};
   if(sql.startsWith('INSERT INTO sdc."AUDIT_LOG"')){
     throw Object.assign(new Error('db-test-exception'),{code:'23514',constraint:'business_integrity'});
   }
   return {rowCount:1,rows:[]};
 },release(){}};
 await assert.rejects(changePassword({connect:async()=>client},'5',old,STRONG),e=>{
   assert.equal(e.passwordChangePhase,'write audit event');
   assert.equal(e.code,'23514');
   return true;
 });
 assert(calls.includes('ROLLBACK'));
 assert(!calls.includes('COMMIT'));
});

test('change password distinguishes COMMIT deferred constraint failure',async()=>{
 const oldHash=await hashPassword(old);
 const client={async query(sql){
   if(sql.includes('SELECT "Password_Hash"'))return {rowCount:1,rows:[{Password_Hash:oldHash}]};
   if(sql==='COMMIT')throw Object.assign(new Error('deferred integrity'),{code:'23514'});
   return {rowCount:1,rows:[]};
 },release(){}};
 await assert.rejects(changePassword({connect:async()=>client},'5',old,STRONG),e=>{
   assert.match(e.passwordChangePhase,/COMMIT/);
   return true;
 });
});
