'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseDoctorForm}=require('../src/doctor-registration/validate');
const {SPECIALTIES}=require('../src/doctor-registration/specialties');
const {registerDoctor}=require('../src/doctor-registration/service');
const {issueCsrf,validateCsrf}=require('../src/security/csrf');
const valid=()=>({first_name:' عمر ',last_name:' ناصر ',phone:'0599 123 456',email:'DOC@example.com',license_number:'MED-88421',password:'Secure1234',confirm_password:'Secure1234',accept_policies:'on','specialty_ids[]':['general_dentistry','endodontics']});

test('accepts doctor form and valid multi-select',()=>{
 const parsed=parseDoctorForm(valid());
 assert.equal(parsed.error,undefined);assert.equal(parsed.data.firstName,'عمر');
 assert.equal(parsed.data.email,'doc@example.com');
 assert.deepEqual(parsed.data.specialties,['general_dentistry','endodontics']);
 assert.equal(parseDoctorForm({...valid(),'specialty_ids[]':'orthodontics'}).data.specialties[0],'orthodontics');
});
test('rejects invalid specialty, missing phone, password errors, bad license, missing consent',()=>{
 const cases=[
  {'specialty_ids[]':[]},{'specialty_ids[]':['admin']},{'specialty_ids[]':['general_dentistry','general_dentistry']},
  {phone:''},{phone:'abc'},{license_number:'\nX'}, {license_number:''},
  {password:'weakpass'}, {confirm_password:'Incorrect1'},{accept_policies:''},
  {email:'not-an-email'}
 ];
 for(const changed of cases){assert(parseDoctorForm({...valid(),...changed}).error,JSON.stringify(changed)+' must be rejected');}
});
test('doctor-specific CSRF cookie cannot be substituted with patient cookie',()=>{
 const r1={headers:{},setHeader(k,v){this.headers[k]=v;}};
 const patient=issueCsrf(r1);const pc=r1.headers['Set-Cookie'].split(';')[0];
 const r2={headers:{},setHeader(k,v){this.headers[k]=v;}};
 const doctor=issueCsrf(r2,'doctor');const dc=r2.headers['Set-Cookie'].split(';')[0];
 assert(validateCsrf({headers:{cookie:dc},body:{csrf_token:doctor}},'doctor'));
 assert(!validateCsrf({headers:{cookie:pc},body:{csrf_token:patient}},'doctor'));
 assert(!validateCsrf({headers:{cookie:dc},body:{csrf_token:doctor+'0'}},'doctor'));
});
function mockPool({errorOn='',roleMissing=false,specialtyMissing=false}={}) {
 const queries=[];
 const client={async query(sql,params=[]){
  queries.push({sql,params});
  if(errorOn && sql.includes(errorOn)){let e=new Error('simulated SQL failure');e.code='23505';throw e;}
  if(sql.includes('SELECT "Role_ID"')) return roleMissing?{rowCount:0,rows:[]}:{rowCount:1,rows:[{Role_ID:'2'}]};
  if(sql.includes('FROM sdc."SPECIALTY"')) return specialtyMissing?{rowCount:0,rows:[]}:{rowCount:1,rows:[{Specialty_ID:'18'}]};
  if(sql.includes('RETURNING "User_ID"')) return {rowCount:1,rows:[{User_ID:'101'}]};
  if(sql.includes('RETURNING "Doctor_ID"')) return {rowCount:1,rows:[{Doctor_ID:'55'}]};
  return {rowCount:1,rows:[]};
 },release(){queries.push({sql:'RELEASE',params:[]});}};
 return {queries,async connect(){return client;}};
}
test('creates pending disabled login doctor and specialty mappings in one transaction',async()=>{
 const pool=mockPool();const doctor=parseDoctorForm(valid()).data;
 const ids=await registerDoctor(pool,doctor,'prototype-v1');
 assert.deepEqual(ids,{userId:'101',doctorId:'55'});
 const queries=pool.queries;
 const u=queries.find(x=>x.sql.includes('INSERT INTO sdc."USER"'));
 assert(u);assert.match(u.sql,/'pending'/);assert.match(u.sql,/false,false/);
 assert(!u.params.includes(doctor.password));assert(u.params[4].startsWith('scrypt$'));
 const d=queries.find(x=>x.sql.includes('INSERT INTO sdc."DOCTOR"'));
 assert(d);assert(d.sql.includes("'pending'"));assert.deepEqual(d.params,[doctor.license,'101']);
 assert.equal(queries.filter(x=>x.sql.includes('INSERT INTO sdc."HAS_SPECIALTY"')).length,2);
 assert.equal(queries.filter(x=>x.sql.includes('INSERT INTO sdc."USER_POLICY_CONSENTS"')).length,2);
 assert(queries.some(x=>x.sql==='COMMIT'));assert(!queries.some(x=>x.sql==='ROLLBACK'));
 assert.equal(queries.at(-1).sql,'RELEASE');
});
test('rolls back all writes on duplicated email/license and missing specialty',async()=>{
 for(const config of [{errorOn:'INSERT INTO sdc."DOCTOR"'},{specialtyMissing:true},{roleMissing:true}]){
  const pool=mockPool(config);
  await assert.rejects(()=>registerDoctor(pool,parseDoctorForm(valid()).data,'prototype-v1'));
  assert(pool.queries.some(x=>x.sql==='ROLLBACK'));
  assert(!pool.queries.some(x=>x.sql==='COMMIT'));
  assert.equal(pool.queries.at(-1).sql,'RELEASE');
 }
});
test('registration fields match EJS and SQL columns, old demo submit is disabled',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../db/schema/001_Smart_Dental_Clinic_Original.sql'),'utf8');
 const form=fs.readFileSync(path.join(__dirname,'../views/auth/register/doctor.ejs'),'utf8');
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 for(const table of ['USER','DOCTOR','HAS_SPECIALTY','SPECIALTY','ROLE','USER_POLICY_CONSENTS'])assert(sql.includes(`CREATE TABLE "${table}"`));
 for(const field of ['first_name','last_name','phone','license_number','email','password','confirm_password','accept_policies','csrf_token','specialty_ids[]'])assert(form.includes(`name="${field}"`),field);
 for(const key of Object.keys(SPECIALTIES))assert(form.includes(`value="${key}"`));
 assert(!form.includes('data-ui-unbound'));assert(!form.includes('data-demo-submit'));assert(form.includes('action="/auth/register/doctor"'));
 assert(server.includes("app.use('/auth/register/doctor'"));
});
