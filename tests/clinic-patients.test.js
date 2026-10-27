'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const svc=require('../src/clinic-patients/service');
const input={clinic_patient_first_name:'سارة',clinic_patient_last_name:'أحمد',clinic_patient_birthdate:'2001-10-10',clinic_patient_gender:'female',clinic_patient_phone:'0599123456',clinic_patient_email:'',blood_type:'O+',health_notes:'معلومات أولية',clinic_patient_allergies:'غبار\nغبار\nبنسلين',clinic_patient_chronic_diseases:'',clinic_patient_current_medications:''};
function fake(rule){const calls=[];const db={async query(sql,values=[]){calls.push({sql,values});return rule(sql,values)||{rowCount:1,rows:[]};},release(){calls.push({sql:'RELEASE'});}};return {calls,pool:{connect:async()=>db,query:async(sql,v)=>{calls.push({sql,values:v});return rule(sql,v)||{rowCount:1,rows:[]};}}};}
test('clinic registration requires demographics but allows unknown blood and no email',()=>{
 const p=svc.parsePatient({...input,blood_type:'unknown',clinic_patient_email:''});assert(p);assert.deepEqual(p.allergies,['غبار','بنسلين']);
 assert.equal(svc.parsePatient({...input,clinic_patient_birthdate:'2026-02-30'}),null);
 assert.equal(svc.parsePatient({...input,clinic_patient_first_name:''}),null);
 assert.equal(svc.parsePatient({...input,clinic_patient_gender:'other'}),null);
});
test('creating patient inserts disabled account, patient and clinic association atomically',async()=>{
 const {calls,pool}=fake(sql=>{
  if(sql.includes('FROM sdc."CLINIC"'))return {rowCount:1,rows:[{id:'10'}]};
  if(sql.includes('JOIN sdc."PATIENT" p'))return {rowCount:0,rows:[]};
  if(sql.includes('FROM sdc."ROLE"'))return {rowCount:1,rows:[{Role_ID:1}]};
  if(sql.includes('INSERT INTO sdc."USER"'))return {rowCount:1,rows:[{User_ID:30}]};
  if(sql.includes('INSERT INTO sdc."PATIENT"('))return {rowCount:1,rows:[{id:'55'}]};
 });
 const r=await svc.create(pool,'10','22',input);assert.deepEqual(r,{status:'ok',id:'55'});
 const account=calls.find(x=>x.sql.includes('INSERT INTO sdc."USER"'));assert(account.sql.includes('false,false'));assert(account.sql.includes('NULL'));
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."REGISTERED_AT"')&&x.values[1]==='10'));
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."PATIENT_ALLERGIES"')));
 assert(calls.some(x=>x.sql.includes('AUDIT_LOG')));assert(calls.some(x=>x.sql==='COMMIT'));
 const patientInsert=calls.find(x=>x.sql.includes('INSERT INTO sdc."PATIENT"('));
 assert.equal(patientInsert.values[1], 'female');
});
test('no automatic linking of an existing account by email or phone',async()=>{
 const {calls,pool}=fake(sql=>{
  if(sql.includes('FROM sdc."CLINIC"'))return {rowCount:1,rows:[{}]};
  if(sql.includes('JOIN sdc."PATIENT" p'))return {rowCount:1,rows:[{}]};
 });
 assert.equal((await svc.create(pool,'10','22',input)).status,'exists');
 assert(!calls.some(x=>x.sql.includes('INSERT INTO sdc."USER"')));
 assert(calls.some(x=>x.sql==='ROLLBACK'));
});
test('clinics cannot access a patient not registered with them',async()=>{
 const {calls,pool}=fake(sql=>sql.includes('FROM sdc."REGISTERED_AT" a JOIN sdc."PATIENT" p')?{rowCount:0,rows:[]}:null);
 assert.equal(await svc.detail(pool,'10','999'),null);assert.equal(calls.length,1);
 assert.equal(await svc.detail(pool,'10','NOT_AN_ID'),null);assert.equal(calls.length,1);
});
test('clinic scoped list and detail queries never return global visits or invoices',()=>{
 const code=fs.readFileSync(path.join(__dirname,'../src/clinic-patients/service.js'),'utf8');
 assert(code.includes('a."Clinic_ID"=$1::bigint AND a."Patient_ID"=$2::bigint'));
 assert(code.includes('b."Clinic_ID"=$1::bigint AND b."Patient_ID"=$2::bigint'));
 assert(code.includes('t."Clinic_ID"=$1::bigint AND t."Patient_ID"=$2::bigint'));
 assert(code.includes('i."Clinic_ID"=$1::bigint AND i."Patient_ID"=$2::bigint'));
});
test('original patient pages expose live rows and clinic membership form, not sample Ahmed',()=>{
 const list=fs.readFileSync(path.join(__dirname,'../views/clinic/patients.ejs'),'utf8');
 const detail=fs.readFileSync(path.join(__dirname,'../views/clinic/patient-details.ejs'),'utf8');
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 assert(list.includes('id="addPatientModal"')&&list.includes('class="patient-card"'));
 assert(list.includes('form="createClinicPatient"')&&list.includes('action="/clinic/patients"'));
 assert(!list.includes('P-2048')&&!list.includes('data-ui-pending'));
 assert(detail.includes('clinicPatientVisitsBody')&&detail.includes('patient.plans'));
 assert(!detail.includes('patient=ahmad')&&!detail.includes('حساسية من Penicillin'));
 assert(server.includes("require('./src/clinic-patients/router')"));
});

// Regression: clinic patient form must submit the session CSRF token under the
// exact name consumed by validateSessionCsrf(), not the legacy `_csrf` alias.
test('new patient form submits a valid session CSRF token with the existing form layout',()=>{
 const view=fs.readFileSync(path.join(__dirname,'../views/clinic/patients.ejs'),'utf8');
 const {createSession,validateSessionCsrf}=require('../src/auth/session');
 assert.match(view,/<form\s+id="createClinicPatient"\s+method="post"\s+action="\/clinic\/patients"/);
 assert.match(view,/<input\s+type="hidden"\s+name="csrf_token"\s+value="<%=\s*csrfToken\s*%>"/);
 assert.doesNotMatch(view,/name="_csrf"/);
 assert.match(view,/type="submit"\s+form="createClinicPatient"/);
 const cookies=[];const res={append(name,value){if(name==='Set-Cookie')cookies.push(value);}};
 const session=createSession(res,{userId:'123',role:'clinic',mfaVerified:true});
 const req={headers:{cookie:cookies.map(c=>c.split(';')[0]).join(';')},body:{csrf_token:session.csrf}};
 assert.equal(validateSessionCsrf(req),true);
 assert.equal(validateSessionCsrf({...req,body:{_csrf:session.csrf}}),false);
});
