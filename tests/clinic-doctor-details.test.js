'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const schedules=require('../src/appointments/schedule');
function harness(opts={}){
 const calls=[];
 const db={async query(sql,params=[]){calls.push({sql,params});
  if(sql.includes('FROM sdc."WORKS_AT"')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[{ok:1}]};
  if(sql.includes('FROM sdc."DOCTOR_WORKING_HOURS"')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[{ok:1}]};
  if(sql.includes('FROM sdc."BOOKING"')&&sql.includes('LIMIT 1'))return {rowCount:opts.bookings?1:0,rows:opts.bookings?[{ok:1}]:[]};
  if(sql.includes('FROM sdc."DOCTOR_ABSENCES"')&&sql.includes('LIMIT 1'))return {rowCount:opts.absenceOverlap?1:0,rows:opts.absenceOverlap?[{ok:1}]:[]};
  return {rowCount:1,rows:[]};
 },release(){calls.push({sql:'RELEASE'});}};
 return {pool:{connect:async()=>db},calls};
}
test('deleting a doctor work shift is refused if future bookings would be stranded',async()=>{
 const {pool,calls}=harness({bookings:true});
 const result=await schedules.save(pool,'10','20','30',{action:'remove_period',day:'1',start:'09:00',end:'13:00'});
 assert.equal(result.status,'bookings_affected');
 assert(calls.some(c=>c.sql.includes('AND NOT EXISTS')&&c.sql.includes('sdc."DOCTOR_WORKING_HOURS"')));
 assert(!calls.some(c=>c.sql.includes('DELETE FROM sdc."DOCTOR_WORKING_HOURS"')));
 assert(calls.some(c=>c.sql==='ROLLBACK'));
});
test('deleting an unneeded shift succeeds without changing other shifts',async()=>{
 const {pool,calls}=harness();
 const result=await schedules.save(pool,'10','20','30',{action:'remove_period',day:'1',start:'09:00',end:'13:00'});
 assert.equal(result.status,'ok');
 const deleteSql=calls.find(c=>c.sql.includes('DELETE FROM sdc."DOCTOR_WORKING_HOURS"'));
 assert.deepEqual(deleteSql.params,['10','20',1,'09:00','13:00']);
 assert(calls.some(c=>c.sql==='COMMIT'));
});
test('adding doctor absence checks confirmed/pending/in-progress bookings first',async()=>{
 const {pool,calls}=harness({bookings:true});
 const r=await schedules.save(pool,'10','20','30',{action:'add_absence',from_date:'2026-11-02',to_date:'2026-11-04',reason:'إجازة'});
 assert.equal(r.status,'bookings_affected');
 assert(calls.some(c=>c.sql.includes('FROM sdc."BOOKING"')&&c.sql.includes("'in_progress'")));
 assert(!calls.some(c=>c.sql.includes('INSERT INTO sdc."DOCTOR_ABSENCES"')));
});
test('duplicate date-range absences cannot be recorded',async()=>{
 const {pool,calls}=harness({absenceOverlap:true});
 const r=await schedules.save(pool,'10','20','30',{action:'add_absence',from_date:'2026-11-02',to_date:'2026-11-04',reason:'إجازة'});
 assert.equal(r.status,'absence_overlap');
 assert(calls.some(c=>c.sql.includes('FROM sdc."DOCTOR_ABSENCES"')));
 assert(!calls.some(c=>c.sql.includes('INSERT INTO sdc."DOCTOR_ABSENCES"')));
});
test('doctor absences save through existing doctor-detail workflow when available',async()=>{
 const {pool,calls}=harness();
 const r=await schedules.save(pool,'10','20','30',{action:'add_absence',from_date:'2026-11-02',to_date:'2026-11-04',reason:'إجازة'});
 assert.equal(r.status,'ok');
 assert(calls.some(c=>c.sql.includes('INSERT INTO sdc."DOCTOR_ABSENCES"')));
 assert(calls.some(c=>c.sql.includes('INSERT INTO sdc."AUDIT_LOG"')));
});
test('doctor detail original page reports errors inline and avoids fake availability badges',()=>{
 const page=fs.readFileSync(path.join(__dirname,'../views/clinic/doctor-details.ejs'),'utf8');
 const router=fs.readFileSync(path.join(__dirname,'../src/appointments/router.js'),'utf8');
 assert(page.includes('class="soft-card p-4 mb-4"'));
 assert(page.includes('id="schedulePeriodModal"')&&page.includes('id="absenceModal"'));
 assert(page.includes('role="alert"')&&page.includes('profile.person.specialties'));
 assert(!page.includes('متاحة اليوم'));
 assert(router.includes("error:errors[result.status]"));
});
