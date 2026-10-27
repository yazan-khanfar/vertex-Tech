'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {hashPassword}=require('../src/security/password');
const {authenticate,loadAccount,clinicsFor,redirectFor}=require('../src/auth/service');
const {createSession,getSession,dropSession,validateSessionCsrf}=require('../src/auth/session');
const fs=require('node:fs');
const path=require('node:path');
function pool(rows){return{calls:[],async query(sql,values){this.calls.push({sql,values});return{rowCount:rows.length,rows};}};}
let hashed;
const sample=(extra={})=>({User_ID:13,Password_Hash:hashed,Account_Status:'active',Login_Enabled:true,Two_Factor_Enabled:false,Role_Name:'Patient',Role_Scope:'System',Doctor_ID:null,License_Status:null,...extra});
test('unified patient and admin login authenticates the password and role (no generic admin bypass)',async()=>{
 hashed=await hashPassword('test-password-very-strong');
 const patient=await authenticate(pool([sample()]),'  USER@example.TEST ','test-password-very-strong');
 assert.deepEqual(patient,{status:'ok',userId:'13',role:'patient'});
 assert.deepEqual(await authenticate(pool([sample()]),'user@example.test','bad'),{status:'invalid'});
 const admin=await authenticate(pool([sample({Role_Name:'Super Admin'})]),'user@example.test','test-password-very-strong');
 assert.equal(admin.role,'admin');
 assert.equal((await authenticate(pool([sample({Role_Name:'Super Admin',Role_Scope:'Clinic'})]),'user@example.test','test-password-very-strong')).status,'unsupported');
});
test('pending/rejected licenses and inactive accounts are never given a full session',async()=>{
 for(const [license,want] of [['pending','pending_license'],['rejected','rejected_license']]){
  const result=await authenticate(pool([sample({Role_Name:'Doctor',Doctor_ID:'6',License_Status:license,Account_Status:'pending',Login_Enabled:false})]),'user@example.test','test-password-very-strong');
  assert.equal(result.status,want);
 }
 for(const change of [{Account_Status:'disabled'},{Login_Enabled:false}]){
  assert.equal((await authenticate(pool([sample(change)]),'user@example.test','test-password-very-strong')).status,'disabled');
 }
 assert.equal((await authenticate(pool([sample({Two_Factor_Enabled:true})]),'user@example.test','test-password-very-strong')).status,'mfa_required');
});
test('verified doctor signs in, and can only get a clinic/doctor context from an authorized membership',async()=>{
 const doctor=await authenticate(pool([sample({Role_Name:'Doctor',Doctor_ID:'8',License_Status:'verified'})]),'user@example.test','test-password-very-strong');
 assert.equal(doctor.role,'doctor');
 assert.equal(redirectFor(doctor,[]),'/onboarding/doctor/choose-path');
 assert.equal(redirectFor(doctor,[{id:'5'}]),'/doctor/index');
 assert.equal(redirectFor(doctor,[{id:'5'},{id:'6'}]),'/account/context');
 const clinicPool=pool([{Clinic_ID:'6',Clinic_Name:'Clinic Six',manager:true}]);
 const available=await clinicsFor(clinicPool,{role:'doctor',doctorId:'8',userId:'13'});
 assert.deepEqual(available,[{id:'6',name:'Clinic Six',manager:true,role:'doctor'}]);
 assert(clinicPool.calls[0].sql.includes('"Approval_Status"=\'approved\''));
 assert(clinicPool.calls[0].sql.includes('"Membership_Status"=\'active\''));
 assert.deepEqual(clinicPool.calls[0].values,['8']);
});
test('staff membership is bound to user and active clinic, role routing is not client-controlled',async()=>{
 const fake=pool([{Clinic_ID:'7',Clinic_Name:'Clinic 7'}]);
 const memberships=await clinicsFor(fake,{role:'staff',userId:'13'});
 assert.equal(fake.calls[0].values[0],'13');
 assert.equal(memberships[0].id,'7');
 assert.equal(redirectFor({role:'staff'},memberships),'/staff/index');
 assert.equal(redirectFor({role:'staff'},[]),'/staff/choose-clinic');
});
test('development session uses unpredictable HTTP-only cookie, validates logout CSRF and revokes',()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV='development';
 try{
  const cookies=[];const res={append(_header,v){cookies.push(v);}};
  const created=createSession(res,{userId:'13',role:'patient'});
  const header=cookies[0];assert(header.includes('HttpOnly'));assert(header.includes('SameSite=Lax'));
  const req={headers:{cookie:header.split(';')[0]},body:{csrf_token:created.csrf}};
  assert.equal(getSession(req)?.userId,'13');
  assert(validateSessionCsrf(req));
  assert(!validateSessionCsrf({...req,body:{csrf_token:'fake'}}));
  dropSession(req,res);
  assert.equal(getSession(req),null);
 }finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});
test('old admin page is redirected to unified login and old demo-submit no longer owns login',()=>{
 const root=path.join(__dirname,'..');
 const admin=fs.readFileSync(path.join(root,'src/admin-review/router.js'),'utf8');
 const login=fs.readFileSync(path.join(root,'views/auth/login.ejs'),'utf8');
 const js=fs.readFileSync(path.join(root,'public/auth/assets/app.js'),'utf8');
 const guard=fs.readFileSync(path.join(root,'src/auth/guard.js'),'utf8');
 assert(admin.includes("res.redirect(303,'/auth/login')"));
 const authRouter=fs.readFileSync(path.join(root,'src/auth/router.js'),'utf8');
 assert(authRouter.includes('/onboarding/doctor/license-status?login=rejected'));
 assert(authRouter.includes('/onboarding/doctor/verification-pending?login=pending')); 
 assert(login.includes('action="/auth/login"'));
 assert(login.includes('name="csrf_token"'));
 assert(!login.includes('data-ui-unbound="" method="post"'));
 assert(js.includes("login?.dataset.serverAuth==='true'"));
 assert(guard.includes('STAFF_PERMISSIONS'));
 assert(guard.includes('adminUserId=actor.userId'));
});
