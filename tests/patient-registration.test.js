'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parsePatientForm } = require('../src/registration/validate');
const { issueCsrf, validateCsrf } = require('../src/security/csrf');
const { hashPassword, verifyPassword } = require('../src/security/password');
const { registerPatient } = require('../src/registration/service');
const valid = () => ({first_name:' سارة ',last_name:' خالد ',email:'SARA@example.com',phone:'0599 123 456',date_of_birth:'2001-04-03',gender:'أنثى',password:'Secure1234',confirm_password:'Secure1234',accept_policies:'on'});
test('patient form validates complete data and normalizes names and email',()=>{
  const r = parsePatientForm(valid());assert.equal(r.error, undefined);assert.equal(r.data.firstName,'سارة');assert.equal(r.data.email,'sara@example.com');assert.equal(r.data.gender,'female');
});
test('reject invalid DOB, mismatch, missing consent and weak password',()=>{
  for(const [field,val] of [['date_of_birth','2021-02-30'],['date_of_birth','2999-01-01'],['confirm_password','Wrong1'],['accept_policies',''],['password','password']]) {
    const body=valid();body[field]=val;assert(parsePatientForm(body).error,`${field} must be rejected`);
  }
});
test('CSRF tokens require a signed valid cookie and matching form token',()=>{
  const result={};const res={setHeader(k,v){result[k]=v;}};
  const token=issueCsrf(res), cookie=result['Set-Cookie'].split(';')[0];
  const req={headers:{cookie},body:{csrf_token:token}};
  assert(validateCsrf(req));
  assert(!validateCsrf({...req,body:{csrf_token:token+'x'}}));
  assert(!validateCsrf({...req,headers:{cookie:cookie.slice(0,-1)+'x'}}));
  assert(!validateCsrf({...req,headers:{cookie:''}}));
});
test('password hashes are salted scrypt and validate without plaintext storage',async()=>{
  const a=await hashPassword('StrongPass123');const b=await hashPassword('StrongPass123');
  assert.notEqual(a,b);assert(a.startsWith('scrypt$'));
  assert(await verifyPassword('StrongPass123',a));assert(!(await verifyPassword('OtherPass123',a)));
});
function mockPool(errorCode) {
  const queries=[];
  const client={async query(sql,params=[]){queries.push({sql,params});
    if(errorCode && sql.includes('INSERT INTO sdc."PATIENT"')) {const error=new Error('simulated');error.code=errorCode;throw error;}
    if(sql.includes('SELECT "Role_ID"'))return {rowCount:1,rows:[{Role_ID:'11'}]};
    if(sql.includes('RETURNING "User_ID"'))return {rows:[{User_ID:'77'}]};
    return {rowCount:1};
   },release(){queries.push({sql:'RELEASE',params:[]});}};
  return {queries,async connect(){return client;}};
}
test('registration writes USER, PATIENT and both consents in one transaction',async()=>{
  const pool=mockPool();const patient=parsePatientForm(valid()).data;
  const created=await registerPatient(pool,patient,'prototype-v1');
  assert.equal(created.userId,'77');
  const seq=pool.queries.map(q=>q.sql);
  assert.equal(seq[0],'BEGIN');assert(seq.some(q=>q.includes('SET LOCAL TIME ZONE')));
  assert.equal(seq.filter(q=>q.includes('INSERT INTO sdc."USER"')).length,1);
  assert.equal(seq.filter(q=>q.includes('INSERT INTO sdc."PATIENT"')).length,1);
  assert.equal(seq.filter(q=>q.includes('INSERT INTO sdc."USER_POLICY_CONSENTS"')).length,2);
  assert(seq.includes('COMMIT'));assert(!seq.includes('ROLLBACK'));assert.equal(seq.at(-1),'RELEASE');
  const patientInsert=pool.queries.find(q=>q.sql.includes('INSERT INTO sdc."PATIENT"'));
  assert.equal(patientInsert.params[1], 'female', 'Patient signup must store canonical English gender');
  const userInsert=pool.queries.find(q=>q.sql.includes('INSERT INTO sdc."USER"'));
  assert(!userInsert.params.includes(patient.password));assert(userInsert.params[4].startsWith('scrypt$'));
});
test('registration rolls back and releases connection after failed query',async()=>{
 const pool=mockPool('23505');
 await assert.rejects(()=>registerPatient(pool,parsePatientForm(valid()).data,'prototype-v1'),{code:'23505'});
 assert(pool.queries.some(q=>q.sql==='ROLLBACK'));assert(!pool.queries.some(q=>q.sql==='COMMIT'));
 assert.equal(pool.queries.at(-1).sql,'RELEASE');
});
test('submitted schema and patient input fields exist in the user-provided SQL and EJS',()=>{
 const sql=fs.readFileSync(require('node:path').join(__dirname,'../db/schema/001_Smart_Dental_Clinic_Original.sql'),'utf8');
 const form=fs.readFileSync(require('node:path').join(__dirname,'../views/auth/register/patient.ejs'),'utf8');
 for (const name of ['USER','PATIENT','ROLE','USER_POLICY_CONSENTS']) assert(sql.includes(`CREATE TABLE "${name}"`));
 for (const name of ['first_name','last_name','date_of_birth','gender','phone','email','password','confirm_password','accept_policies','csrf_token']) assert(form.includes(`name="${name}"`));
 assert(!form.includes('data-ui-unbound'));
});
