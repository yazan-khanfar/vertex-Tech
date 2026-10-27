'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {hashPassword}=require('../src/security/password');
const service=require('../src/clinic-account-settings/service');
const root=path.resolve(__dirname,'..');
test('contact and language validation',()=>{
 assert.deepEqual(service.contactFromBody({email:' TEST@example.org ',phone:'0599 123 456'}),{email:'test@example.org',phone:'0599 123 456'});
 for(const email of ['notanemail','', 'ab@c', '  @  '])assert.equal(service.contactFromBody({email,phone:'0599000000'}),null);
 assert.equal(service.contactFromBody({email:'x@y.net',phone:'123'}),null);
 assert.equal(service.preferredLanguage('ar'),'ar');assert.equal(service.preferredLanguage('en'),'en');assert.equal(service.preferredLanguage('fr'),null);
});
test('account changes require a password and roll back wrong password',async()=>{
 const pass=await hashPassword('VerySecurePassword@12345');const sql=[];
 const pool={async connect(){return {async query(q,params=[]){sql.push(q);if(q.includes('FOR UPDATE'))return {rowCount:1,rows:[{Password_Hash:pass,Email:'old@example.org',Phone:'0599000000'}]};return {rowCount:1,rows:[]};},release(){}}}};
 assert.equal((await service.changeContact(pool,3,{email:'new@example.org',phone:'0599000001',password:'wrong'})).status,'password');
 assert(sql.includes('ROLLBACK'));assert(!sql.some(q=>q.includes('UPDATE sdc."USER"')));
});
test('account contact update, audit and commit run atomically',async()=>{
 const pass=await hashPassword('VerySecurePassword@12345');const log=[];
 const pool={async connect(){return {async query(q,values=[]){log.push({q,values});if(q.includes('FOR UPDATE'))return {rowCount:1,rows:[{Password_Hash:pass,Email:'old@example.org',Phone:'0599000000'}]};return {rowCount:q.startsWith('SELECT 1')?0:1,rows:[]};},release(){log.push({q:'RELEASE'})}}}};
 assert.equal((await service.changeContact(pool,3,{email:'new@example.org',phone:'0599000001',password:'VerySecurePassword@12345'})).status,'ok');
 assert(log.some(x=>x.q.includes('UPDATE sdc."USER"')&&x.values[0]===3));
 assert(log.some(x=>x.q.includes('AUDIT_LOG')));assert(log.some(x=>x.q==='COMMIT'));
});
test('language is persisted as user preference, without false translation claim',async()=>{
 const log=[];
 const pool={async connect(){return {async query(q,values=[]){log.push({q,values});return {rowCount:1,rows:[]};},release(){}}}};
 assert.equal((await service.changeLanguage(pool,4,'en')).status,'ok');
 assert(log.some(v=>v.q.includes('Preferred_Language')&&v.values[1]==='en'));
 assert(log.some(v=>v.q.includes('AUDIT_LOG')));
 assert.equal((await service.changeLanguage(pool,4,'other')).status,'invalid');
});
test('original account settings retains MFA, sessions, password and real account edits',()=>{
 const view=fs.readFileSync(path.join(root,'views/clinic/account-settings.ejs'),'utf8');
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const router=fs.readFileSync(path.join(root,'src/clinic-account-settings/router.js'),'utf8');
 assert(view.includes('action="/clinic/account-settings"'));
 assert(view.includes('name="email"')&&view.includes('name="phone"')&&view.includes('name="password"'));
 assert(view.includes('name="language"')&&view.includes('name="csrf_token"'));
 assert(view.includes('mfa-manager'));
 assert(view.includes('active-sessions'));
 assert(view.includes('action="/auth/change-password"'));
 assert(!view.includes('data-ui-unbound')&&!view.includes('owner@example.test'));
 assert(!view.includes('تم تحديث اللغة الافتراضية تجريبياً'));
 assert(server.includes("require('./src/clinic-account-settings/router')"));
 assert(router.includes('validateSessionCsrf(req)'));
});
