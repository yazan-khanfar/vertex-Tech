'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const workdir=fs.mkdtempSync(path.join(os.tmpdir(),'sdc-clinic-test-'));
process.env.CLINIC_DOCUMENTS_DIR=workdir;
const svc=require('../src/clinic-onboarding/service');
const valid={clinic_name:'عيادة جديدة',city:'جنين',area:'وسط البلد',phone:'0590000000',email:'owner@example.test',address:'الشارع الرئيسي',facility_license_number:'CL-TEST-0123',latitude:'32.459',longitude:'35.3',notes:'إنشاء عيادة جديدة'};
const sample=(data={})=>({...valid,...data});
test('required clinic data and geocoordinates validated before database write',()=>{
 assert.equal(svc.parseFields(sample()).data.facilityLicense,'CL-TEST-0123');
 for(const data of [{latitude:''},{longitude:'0.1.2'},{latitude:'95'},{longitude:'181'},{clinic_name:''},{facility_license_number:''},{email:'invalid'},{area:''}])
  assert(svc.parseFields(sample(data)).error,JSON.stringify(data));
});
test('file uploads only accept real PDF/JPEG/PNG magic, not renamed scripts',()=>{
 const pdf=Buffer.from('%PDF-1.5\nobj\n');const jpg=Buffer.from([255,216,255,224,1]);const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
 assert.equal(svc.docType(pdf).extension,'.pdf');assert.equal(svc.docType(jpg).extension,'.jpg');assert.equal(svc.docType(png).extension,'.png');
 assert.equal(svc.docType(Buffer.from('<script>alert(1)</script>')),null);
 assert(svc.checkedDocs({},true).error);
 assert(svc.checkedDocs({license:[{buffer:Buffer.from('HTML'),size:4}]},false).error);
});
test('resubmission shown only if reviewer asked for information and request not updated afterwards',()=>{
 const submitted=new Date('2026-10-25T09:00:00Z'),reviewed=new Date('2026-10-25T11:00:00Z');
 assert.equal(svc.labelStatus({Approval_Status:'pending',Submitted_At:submitted,Reviewed_At:reviewed}),'needs_info');
 assert.equal(svc.labelStatus({Approval_Status:'pending',Submitted_At:reviewed,Reviewed_At:submitted}),'pending');
 assert.equal(svc.labelStatus({Approval_Status:'approved'}),'approved');
 assert.equal(svc.labelStatus({Approval_Status:'rejected'}),'rejected');
});
function fakeDb({reviewed=false,authorized=true,docs=2,failOn=null}={}){
 const calls=[];const client={async query(sql,args=[]){calls.push({sql,args});if(failOn&&sql.includes(failOn))throw Object.assign(Error('forced'),{code:'TEST'});
  if(sql.includes('sdc_is_superadmin'))return{rows:[{allowed:authorized}],rowCount:1};
  if(sql.includes('SELECT "Approval_Status"'))return{rows:[{Approval_Status:reviewed?'approved':'pending',Manager_Doctor_ID:'1',Manager_User_ID:'5'}],rowCount:1};
  if(sql.includes('COUNT(DISTINCT'))return{rows:[{present:docs}],rowCount:1};
  return{rows:[],rowCount:1};},release(){calls.push({sql:'RELEASE'});}};
 return {calls,async connect(){return client}};
}
test('Super Admin approval is atomic, grants doctor membership and audit; no guessed IDs',async()=>{
 const pool=fakeDb();const actor={role:'admin',userId:'4'};
 const result=await svc.reviewClinic(pool,actor,'7','approve','تمت مراجعة بيانات العيادة والتراخيص',{details:'on',contact:'on',license:'on',manager:'on'});
 assert.equal(result.status,'ok');
 assert(pool.calls.some(v=>v.sql.includes('set_config(\'sdc.user_id\'')&&v.args[0]==='4'));
 assert(pool.calls.some(v=>v.sql.includes('INSERT INTO sdc."WORKS_AT"')&&v.args[0]==='7'&&v.args[1]==='1'));
 assert(pool.calls.some(v=>v.sql.includes('INSERT INTO sdc."NOTIFICATION"')&&v.args[3]==='5'));
 assert(pool.calls.some(v=>v.sql.includes('INSERT INTO sdc."AUDIT_LOG"')));
 assert(pool.calls.some(v=>v.sql==='COMMIT'));
});
test('approval blocked without checks, verified documents or admin authority',async()=>{
 const actor={role:'admin',userId:'4'};
 for(const [pool,result] of [[fakeDb({docs:1}),'documents'],[fakeDb({authorized:false}),'forbidden'],[fakeDb({reviewed:true}),'reviewed']]){
  const response=await svc.reviewClinic(pool,actor,'7','approve','تمت مراجعة بيانات العيادة والتراخيص',{details:'on',contact:'on',license:'on',manager:'on'});
  assert.equal(response.status,result);assert(!pool.calls.some(v=>v.sql.includes('INSERT INTO sdc."WORKS_AT"')));
  assert(pool.calls.some(v=>v.sql==='ROLLBACK'));
 }
 const pool=fakeDb();assert.equal((await svc.reviewClinic(pool,actor,'7','approve','ملاحظة صحيحة هنا',{details:'on'})).status,'checks');
 assert.equal(pool.calls.length,0);
 assert.equal((await svc.reviewClinic(pool,{role:'doctor',userId:'3'},'7','approve','ملاحظة صحيحة هنا',{})).status,'forbidden');
});
test('database failure rolls back clinic review and does not commit',async()=>{
 const pool=fakeDb({failOn:'INSERT INTO sdc."AUDIT_LOG"'});
 await assert.rejects(()=>svc.reviewClinic(pool,{role:'admin',userId:'4'},'7','reject','سبب الرفض لعدم اكتمال الترخيص',{}));
 assert(pool.calls.some(v=>v.sql==='ROLLBACK'));assert(!pool.calls.some(v=>v.sql==='COMMIT'));
});
test('single-clinic login persists the active context in PostgreSQL',()=>{
 const auth=fs.readFileSync(path.join(__dirname,'../src/auth/router.js'),'utf8');
 assert(auth.includes('if(clinics.length===1)await setTrackedClinic(req,clinics[0].id,getPool())'));
});
test('existing pages have real forms and no new duplicate clinic forms',()=>{
 const root=path.resolve(__dirname,'..');
 const doctor=fs.readFileSync(path.join(root,'views/onboarding/doctor/clinic/create.ejs'),'utf8');
 const resubmit=fs.readFileSync(path.join(root,'views/onboarding/doctor/clinic/application-status.ejs'),'utf8');
 const admin=fs.readFileSync(path.join(root,'views/admin/clinic-application-details.ejs'),'utf8');
 for(const fragment of ['name="csrf_token"','enctype="multipart/form-data"','name="facility_license_number"','name="latitude"','name="longitude"'])assert(doctor.includes(fragment),fragment);
 assert(!doctor.includes('data-ui-unbound'));assert(resubmit.includes('action="/onboarding/doctor/clinic/application-status"'));
 assert(admin.includes('action="/admin/clinic-application-details"'));
 assert(!admin.includes('CA-001'));assert(!admin.includes('data-ui-pending'));
});

test('doctor submission persists clinic and two versioned private documents within one transaction',async()=>{
 const pdf=Buffer.from('%PDF-1.5\nobj\n');
 const uploads={license:[{buffer:pdf,size:pdf.length,originalname:'license.pdf'}],manager:[{buffer:pdf,size:pdf.length,originalname:'manager.pdf'}]};
 const calls=[];const client={async query(sql,args=[]){calls.push({sql,args});
  if(sql.includes('FROM sdc."DOCTOR"'))return{rowCount:1,rows:[{Doctor_ID:'1'}]};
  if(sql.includes('SELECT "Clinic_ID"'))return{rowCount:0,rows:[]};
  if(sql.includes('RETURNING "Clinic_ID"'))return{rowCount:1,rows:[{Clinic_ID:'7'}]};
  if(sql.includes('MAX("Version_Number")'))return{rowCount:1,rows:[{next_version:'1'}]};
  return{rowCount:1,rows:[]};},release(){}};
 const result=await svc.submitClinic({async connect(){return client}}, {role:'doctor',userId:'3',doctorId:'1'},sample(),uploads);
 try{assert.deepEqual(result,{status:'ok',clinicId:'7'});
  assert(calls.some(v=>v.sql.includes('INSERT INTO sdc."CLINIC"')));
  assert.equal(calls.filter(v=>v.sql.includes('INSERT INTO sdc."CLINIC_DOCUMENTS"')).length,2);
  assert(calls.some(v=>v.sql.includes('INSERT INTO sdc."AUDIT_LOG"')));
  assert(calls.some(v=>v.sql==='COMMIT'));assert.equal(fs.readdirSync(workdir).length,2);
 }finally{fs.rmSync(workdir,{recursive:true,force:true});}
});
