'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');const path=require('node:path');
const {newSecret,totp,matchTotp,encryptSecret,decryptSecret,recoveryCodes,normalizedRecovery,hashRecovery,otpauthUri}=require('../src/mfa/crypto');
const {hashPassword}=require('../src/security/password');
const {enableMfa,disableMfa,checkSecondFactor}=require('../src/mfa/service');
const {createSession,dropSession,getSession,startMfaChallenge,getMfaChallenge,failMfaChallenge,finishMfaChallenge,revokeOtherSessions}=require('../src/auth/session');
process.env.MFA_ENCRYPTION_KEY='a'.repeat(64);
function pool(handler){const calls=[];const client={async query(q,p){calls.push({q,p});return handler(q,p,calls);},release(){}};return {calls,async connect(){return client;},async query(q,p){return client.query(q,p);}};}
function response(){const cookies=[];return {cookies,append(h,v){assert.equal(h,'Set-Cookie');cookies.push(v);}};}
test('RFC 6238 sample and drift checking work without leaking secrets',()=>{
 const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
 assert.equal(totp(secret,1),'287082');
 assert.equal(matchTotp(secret,'287082',59000),1);
 assert.equal(matchTotp(secret,'287082',59000+120000),null);
 assert.equal(matchTotp(secret,'123456junk',59000),null);
 assert.match(newSecret(),/^[A-Z2-7]{32}$/);
});
test('AES-GCM encryption uses configured stable secret, detects tampering',()=>{
 const original=newSecret(),cipher=encryptSecret(original);
 assert(!cipher.includes(original));assert.equal(decryptSecret(cipher),original);
 assert.throws(()=>decryptSecret(cipher.replace(/.$/,c=>c==='0'?'1':'0')));
 const previous=process.env.MFA_ENCRYPTION_KEY;delete process.env.MFA_ENCRYPTION_KEY;
 assert.throws(()=>encryptSecret(original),/MFA_ENCRYPTION_KEY/);
 process.env.MFA_ENCRYPTION_KEY=previous;
});
test('recovery codes are independent, high entropy, one-time hashes',()=>{
 const codes=recoveryCodes();assert.equal(codes.length,8);assert.equal(new Set(codes).size,8);
 assert(codes.every(x=>/^[A-F0-9]{32}$/.test(x)));
 assert.equal(normalizedRecovery(' ' + codes[0].slice(0,16)+'-'+codes[0].slice(16)+' '),codes[0]);
 assert.equal(normalizedRecovery('not-a-code'),null);
 assert.equal(hashRecovery(2,codes[0])===hashRecovery(3,codes[0]),false);
 assert(otpauthUri(newSecret(),'patient@example.test').includes('issuer=Smart%20Dental%20Clinic'));
});
test('MFA enable commits encrypted secret, one-time recovery hashes and audit atomically',async()=>{
 const secret=newSecret();const db=pool((sql)=>{
  if(sql.startsWith('UPDATE sdc."USER"'))return {rowCount:1,rows:[{User_ID:'23'}]};return {rowCount:1,rows:[{}]};
 });
 const result=await enableMfa(db,'23',secret);assert(result.ok);assert.equal(result.codes.length,8);
 const insertRecovery=db.calls.filter(x=>x.q.startsWith('INSERT INTO sdc."USER_RECOVERY_CODES"'));assert.equal(insertRecovery.length,8);
 assert(!JSON.stringify(db.calls).includes(result.codes[0]));
 assert(db.calls.some(x=>x.q==='COMMIT'));
 assert(db.calls.some(x=>x.q.includes('account.mfa.enabled')));
});
test('MFA recovery code is consumed once and rejects replay',async()=>{
 const code=recoveryCodes()[0];let spent=false;const db=pool((sql)=>{
  if(sql.includes('FROM sdc."USER" WHERE'))return {rowCount:1,rows:[{Two_Factor_Enabled:true,Two_Factor_Secret_Encrypted:encryptSecret(newSecret())}]};
  if(sql.startsWith('UPDATE sdc."USER_RECOVERY_CODES"')){if(spent)return {rowCount:0,rows:[]};spent=true;return {rowCount:1,rows:[{}]};}
  return {rowCount:1,rows:[]};
 });
 assert((await checkSecondFactor(db,'23',code)).ok);
 assert(!(await checkSecondFactor(db,'23',code)).ok);
});
test('disabling MFA requires password and a second factor',async()=>{
 const hash=await hashPassword('Strong-password-2026!');const secret=newSecret(),code=totp(secret);
 const db=pool(sql=>{
  if(sql.startsWith('SELECT "Password_Hash"'))return {rowCount:1,rows:[{Password_Hash:hash,Two_Factor_Enabled:true,Two_Factor_Secret_Encrypted:encryptSecret(secret)}]};
  return {rowCount:1,rows:[]};
 });
 assert(!(await disableMfa(db,'23','wrong',code)));
 assert(await disableMfa(db,'23','Strong-password-2026!',code));
 assert(db.calls.some(x=>x.q.includes('"Two_Factor_Enabled"=false')));
});
test('pending MFA cookie is not a full application session and expires on failure',()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV='development';
 try{
  const res=response();startMfaChallenge(res,{userId:'11',role:'patient'});
  const raw=res.cookies.at(-1).split(';')[0],req={headers:{cookie:raw}};
  assert(getMfaChallenge(req));assert.equal(getSession(req),null);
  for(let i=0;i<5;i++)failMfaChallenge(req);
  assert.equal(getMfaChallenge(req),null);
  finishMfaChallenge(req,res);
  const r2=response();const s=createSession(r2,{userId:'11',role:'patient',mfaVerified:true});
  assert(s.mfaVerified);const q={headers:{cookie:r2.cookies[0].split(';')[0]}};
  revokeOtherSessions('11',s);assert(getSession(q));dropSession(q,r2);assert.equal(getSession(q),null);
 }finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});
test('MFA screens and roles use real server-side forms with no preview actions',()=>{
 const root=path.resolve(__dirname,'..');
 const mfa=fs.readFileSync(path.join(root,'views/auth/mfa.ejs'),'utf8');
 assert(mfa.includes('action="/auth/mfa"'));assert(!mfa.includes('data-ui-unbound'));
 const partial=fs.readFileSync(path.join(root,'views/partials/shared/mfa-manager.ejs'),'utf8');
 for(const action of ['/auth/security/start','/auth/security/confirm','/auth/security/disable'])assert(partial.includes(action));
 for(const file of ['views/patient/profile.ejs','views/doctor/profile.ejs','views/admin/settings.ejs','views/clinic/account-settings.ejs','views/staff/profile.ejs']){
  const data=fs.readFileSync(path.join(root,file),'utf8');assert(data.includes('mfa-manager'));assert(!data.includes('تأكيد الإعداد التجريبي'));
 }
 assert(!fs.existsSync(path.join(root,'views/auth/security.ejs')));
});
