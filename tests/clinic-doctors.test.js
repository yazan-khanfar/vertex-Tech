'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const svc=require('../src/clinic-doctors/service');
const file=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
function fakeDb(lookup){const calls=[];const db={async query(sql,values=[]){calls.push({sql,values});return lookup(sql,values)||{rowCount:1,rows:[]};},release(){calls.push({sql:'RELEASE'})}};return {pool:{connect:async()=>db},calls};}
test('invitation fields reject fake ids invalid dates and excessive notes',()=>{
 assert.equal(svc.inviteFields({doctor_id:'D-102',clinic_doctor_start_date:'2026-10-26'}),null);
 assert.equal(svc.inviteFields({doctor_id:'12',clinic_doctor_start_date:'2026-02-30'}),null);
 assert.equal(svc.inviteFields({doctor_id:'12',clinic_doctor_start_date:'2026-10-26',clinic_doctor_notes:'x'.repeat(2001)}),null);
 assert.deepEqual(svc.inviteFields({doctor_id:'12',clinic_doctor_start_date:'2026-10-26',clinic_doctor_notes:' test '}),{doctorId:'12',startDate:'2026-10-26',notes:'test'});
});
test('manager can send pending invitation atomically, not automatic clinic access',async()=>{
 const {pool,calls}=fakeDb(sql=>{
  if(sql.includes('SELECT "Clinic_ID" FROM sdc."CLINIC"'))return {rowCount:1,rows:[{Clinic_ID:10}]};
  if(sql.includes('FROM sdc."DOCTOR" d JOIN sdc."USER"'))return {rowCount:1,rows:[{Doctor_ID:20,User_ID:30}]};
  if(sql.includes('SELECT "Membership_Status" AS status'))return {rowCount:0,rows:[]};
 });
 const r=await svc.invitation(pool,10,11,12,{doctor_id:'20',clinic_doctor_start_date:'2026-10-26',clinic_doctor_notes:'ok'});
 assert.equal(r.status,'ok');assert(calls.some(c=>c.sql.includes('INSERT INTO sdc."WORKS_AT"')&&c.sql.includes("'pending'")));
 assert(!calls.some(c=>c.sql.includes('WORKS_AT')&&c.sql.includes("'active'")));
 assert(calls.some(c=>c.sql.includes('NOTIFICATION')));assert(calls.some(c=>c.sql==='COMMIT'));
});
test('manager cannot invite if clinic is not theirs',async()=>{
 const {pool,calls}=fakeDb(sql=>sql.includes('SELECT "Clinic_ID" FROM sdc."CLINIC"')?{rowCount:0,rows:[]}:null);
 assert.equal((await svc.invitation(pool,10,11,12,{doctor_id:'20',clinic_doctor_start_date:'2026-10-26'})).status,'forbidden');
 assert(calls.some(c=>c.sql==='ROLLBACK'));assert(!calls.some(c=>c.sql.includes('INSERT INTO sdc."WORKS_AT"')));
});
test('doctor acceptance is bound to owned doctor ID and pending membership',async()=>{
 const {pool,calls}=fakeDb(sql=>{
  if(sql.includes('SELECT w."Membership_Status" AS status'))return {rowCount:1,rows:[{status:'pending',Manager_Doctor_ID:11,Clinic_Status:'active',Approval_Status:'approved'}]};
  if(sql.includes('SELECT "User_ID" FROM sdc."DOCTOR"'))return {rowCount:1,rows:[{User_ID:15}]};
 });
 assert.equal((await svc.decide(pool,20,30,10,'accept')).status,'ok');
 const update=calls.find(c=>c.sql.includes('UPDATE sdc."WORKS_AT"'));assert.equal(update.values[0],10);assert.equal(update.values[1],20);
 assert.equal(update.values[2],'active');assert(calls.some(c=>c.sql==='COMMIT'));
 const bad=await svc.decide(pool,20,30,10,'disable');assert.equal(bad.status,'invalid');
});
test('doctor cannot accept an already consumed invitation',async()=>{
 const {pool,calls}=fakeDb(sql=>sql.includes('SELECT w."Membership_Status" AS status')?{rowCount:1,rows:[{status:'active',Clinic_Status:'active',Approval_Status:'approved'}]}:null);
 assert.equal((await svc.decide(pool,20,30,10,'accept')).status,'unavailable');
 assert(!calls.some(c=>c.sql.startsWith('UPDATE sdc."WORKS_AT"')));
});
test('clinic cannot suspend doctor with pending or confirmed bookings',async()=>{
 const {pool,calls}=fakeDb(sql=>{
  if(sql.includes('SELECT "Membership_Status" AS status'))return {rowCount:1,rows:[{status:'active'}]};
  if(sql.includes('FROM sdc."BOOKING"'))return {rowCount:1,rows:[{booking:1}]};
 });
 assert.equal((await svc.manage(pool,10,11,12,20,'suspend')).status,'bookings');
 assert(!calls.some(c=>c.sql.startsWith('UPDATE sdc."WORKS_AT"')));
 assert.equal((await svc.manage(pool,10,11,12,11,'suspend')).status,'forbidden');
});
test('original clinic and doctor pages retain design and use real membership forms',()=>{
 const clinic=file('views/clinic/doctors.ejs'),doctor=file('views/doctor/profile.ejs'),router=file('src/appointments/router.js');
 assert(clinic.includes('id="addDoctorModal"')&&clinic.includes('class="doctor-card"'));
 assert(clinic.includes('action="/clinic/doctors/invite"')&&clinic.includes('eligibleDoctors'));
 assert(!clinic.includes('D-108')&&!clinic.includes('D-109')&&!clinic.includes('id="saveClinicDoctorBtn" disabled'));
 assert(doctor.includes('id="clinic-invitations"')&&doctor.includes('action="/doctor/profile/membership"'));
 assert(router.includes("post('/doctors/invite'")&&router.includes('validateSessionCsrf(req)'));
 assert(file('db/migrations/004_doctor_clinic_invitations.sql').includes("'pending'"));
});
