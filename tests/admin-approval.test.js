'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
const {reviewDoctor,authenticateAdmin,adminIsActive}=require('../src/admin-review/service');
const {hashPassword}=require('../src/security/password');
const valid=()=>({doctorId:'1',adminUserId:'2',decision:'approve',reason:'تمت مطابقة الترخيص مع بيانات الطبيب',checks:{number_valid:'on',identity_matches:'on',specialty_matches:'on'}});
function fakeDb({doctorState='pending',accountState='pending',adminAllowed=true,errorAt=''}={}){
 const calls=[];
 const db={async query(sql,args=[]){calls.push({sql,args});if(errorAt&&sql.includes(errorAt))throw new Error('SQL failed');
  if(sql.includes('sdc_is_superadmin'))return {rows:[{allowed:adminAllowed}],rowCount:1};
  if(sql.includes('FROM sdc."DOCTOR" d JOIN sdc."USER" u')&&sql.includes('FOR UPDATE'))return {rows:[{Doctor_ID:'1',User_ID:'5',License_Status:doctorState,Account_Status:accountState}],rowCount:1};
  return {rows:[],rowCount:1};},release(){calls.push({sql:'RELEASE'});}};
 return {calls,async connect(){return db;}};
}
test('approval requires checked validations and a meaningful reason',async()=>{
 for(const change of [{checks:{}},{reason:'short'},{decision:'change'},{doctorId:'abc'}]){
  const pool=fakeDb();const result=await reviewDoctor(pool,{...valid(),...change});
  assert(['invalid','invalid_checks'].includes(result.status));assert.equal(pool.calls.length,0);
 }
});
test('approve updates both doctor + user and creates audit transaction with sdc.user_id',async()=>{
 const pool=fakeDb();assert.deepEqual(await reviewDoctor(pool,valid()),{status:'ok',decision:'approve'});
 assert(pool.calls.some(x=>x.sql.includes('set_config(\'sdc.user_id\'')&&x.args[0]==='2'));
 const doctor=pool.calls.find(x=>x.sql.includes('UPDATE sdc."DOCTOR"'));assert.deepEqual(doctor.args.slice(0,2),['verified','2']);
 const user=pool.calls.find(x=>x.sql.includes('UPDATE sdc."USER"'));assert.deepEqual(user.args.slice(0,2),['active',true]);
 const audit=pool.calls.find(x=>x.sql.includes('INSERT INTO sdc."AUDIT_LOG"'));assert.equal(audit.args[0],'doctor.license.approved');
 assert(pool.calls.some(x=>x.sql==='COMMIT'));assert(!pool.calls.some(x=>x.sql==='ROLLBACK'));
});
test('reject keeps doctor login disabled and records reviewer + reason',async()=>{
 const pool=fakeDb();const result=await reviewDoctor(pool,{...valid(),decision:'reject',checks:{}});
 assert.equal(result.status,'ok');
 assert.equal(pool.calls.find(x=>x.sql.includes('UPDATE sdc."DOCTOR"')).args[0],'rejected');
 assert.deepEqual(pool.calls.find(x=>x.sql.includes('UPDATE sdc."USER"')).args.slice(0,2),['disabled',false]);
 assert.equal(pool.calls.find(x=>x.sql.includes('INSERT INTO sdc."AUDIT_LOG"')).args[0],'doctor.license.rejected');
});
test('already reviewed doctor and unauthorized admin make no writes',async()=>{
 for(const config of [{doctorState:'verified'},{accountState:'active'},{adminAllowed:false}]){
  const pool=fakeDb(config);const result=await reviewDoctor(pool,valid());
  assert(['already_reviewed','unauthorized'].includes(result.status));
  assert(!pool.calls.some(x=>x.sql.includes('UPDATE sdc."')));
  assert(pool.calls.some(x=>x.sql==='ROLLBACK'));
 }
});
test('database failure is rolled back',async()=>{
 const pool=fakeDb({errorAt:'INSERT INTO sdc."AUDIT_LOG"'});
 await assert.rejects(()=>reviewDoctor(pool,valid()));
 assert(pool.calls.some(x=>x.sql==='ROLLBACK'));assert(!pool.calls.some(x=>x.sql==='COMMIT'));
});
test('Super Admin authentication checks role, status, password',async()=>{
 const hash=await hashPassword('StrongPassword_2026!');
 const pool={async query(sql,args){if(sql.includes('SELECT 1'))return{rowCount:1,rows:[{}]};return{rowCount:1,rows:[{User_ID:'2',Password_Hash:hash}]};}};
 assert.equal(await authenticateAdmin(pool,'Admin@example.com','StrongPassword_2026!'),'2');
 assert.equal(await authenticateAdmin(pool,'Admin@example.com','wrong'),null);
 assert.equal(await adminIsActive(pool,'2'),true);assert.equal(await adminIsActive(pool,'abc'),false);
});
test('no preview-only buttons in verification; real admin review EJS, clean links and schema values',()=>{
 const root=path.resolve(__dirname,'..');
 const page=fs.readFileSync(path.join(root,'views/onboarding/doctor/verification-pending.ejs'),'utf8');
 assert(!page.includes('متابعة العرض بعد التحقق'));assert(!page.includes('عرض مثال: يحتاج استكمال'));
 const review=fs.readFileSync(path.join(root,'views/admin/doctor-license-review.ejs'),'utf8');
 for(const marker of ['action="/admin/doctor-license-review"','name="csrf_token"','name="doctor_id"','value="approve"','value="reject"','<%= doctor.License_Number %>'])assert(review.includes(marker),marker);
 assert(!review.includes('D-108'));assert(!review.includes('data-ui-pending'));
 const sql=fs.readFileSync(path.join(root,'db/schema/001_Smart_Dental_Clinic_Original.sql'),'utf8');
 assert(sql.includes("'pending', 'verified', 'rejected'"));assert(sql.includes("'active', 'pending', 'suspended', 'disabled'"));
});
