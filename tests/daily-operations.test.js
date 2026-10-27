'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const svc=require('../src/daily-operations/service');
const {localNow}=require('../src/appointments/service');
function poolFor(booking={}){
 const calls=[];
 const item={id:'17',status:'confirmed',arrived:null,date:localNow().date,time:'09:00',doctor_id:'6',doctor_user:'33',patient_user:'44',...booking};
 const db={calls,async query(sql,params){
  calls.push({sql,params});
  if(sql.includes('FROM sdc."BOOKING" b')&&sql.includes('FOR UPDATE OF b'))return {rows:[item],rowCount:1};
  if(sql.includes('FROM sdc."BOOKING" b')&&sql.includes('LEFT JOIN sdc."VISIT" v')&&sql.includes('WHERE b."Booking_ID"'))return {rows:[item],rowCount:1};
  return {rows:[],rowCount:0};
 },release(){}};
 return {calls,connect:async()=>db};
}
test('dashboard counters depend on real statuses, and do not count future patients as arrived',()=>{
 assert.deepEqual(svc.counters([
  {arrived:false,status:'confirmed'},
  {arrived:true,status:'confirmed'},
  {arrived:true,status:'in_progress'},
  {arrived:false,status:'no_show'},
 ]),{arrived:2,waiting:1,treating:1,noShow:1});
});
test('invalid IDs, actions and missing clinical complaint rejected before connecting',async()=>{
 const noDb={connect(){throw new Error('No connection for invalid actions');}};
 assert.deepEqual(await svc.clinicAction(noDb,{clinicId:'2',userId:'1',bookingId:'bad',action:'check_in'}),{status:'invalid'});
 assert.deepEqual(await svc.clinicAction(noDb,{clinicId:'2',userId:'1',bookingId:'4',action:'complete'}),{status:'invalid'});
 assert.deepEqual(await svc.doctorAction(noDb,{clinicId:'2',doctorId:'7',userId:'1',bookingId:'4',action:'start',complaint:''}),{status:'invalid'});
});
test('check-in on confirmed appointment records attendance and notifies doctor',async()=>{
 const pool=poolFor();const result=await svc.clinicAction(pool,{clinicId:'4',userId:'2',bookingId:'17',action:'check_in'});
 assert.deepEqual(result,{status:'ok',id:'17'});
 assert(pool.calls.some(c=>c.sql.includes('UPDATE sdc."BOOKING" SET "Arrived_At"=')&&c.params[0]==='17'));
 assert(pool.calls.some(c=>c.sql.includes('INSERT INTO sdc."AUDIT_LOG"')));
 assert(pool.calls.some(c=>c.sql.includes('INSERT INTO sdc."NOTIFICATION"')&&c.params[2]==='33'));
 assert(pool.calls.some(c=>c.sql==='COMMIT'));
});
test('cannot mark no-show before appointment starts or after patient check-in',async()=>{
 let result=await svc.clinicAction(poolFor({time:'23:59'}),{clinicId:'4',userId:'2',bookingId:'17',action:'no_show'});
 assert.equal(result.status,'too_early');
 result=await svc.clinicAction(poolFor({arrived:'2026-10-26T10:00'}),{clinicId:'4',userId:'2',bookingId:'17',action:'no_show'});
 assert.equal(result.status,'already_arrived');
});
test('start of visit requires arrival and cannot begin cancelled booking',async()=>{
 let result=await svc.doctorAction(poolFor({arrived:false,status:'confirmed'}),{clinicId:'4',doctorId:'6',userId:'33',bookingId:'17',action:'start',complaint:'ألم عند المضغ'});
 assert.equal(result.status,'invalid_state');
 result=await svc.doctorAction(poolFor({arrived:true,status:'cancelled'}),{clinicId:'4',doctorId:'6',userId:'33',bookingId:'17',action:'start',complaint:'ألم'});
 assert.equal(result.status,'invalid_state');
});
test('visit begins with patient-actual complaint and booking ID; retry never inserts duplicate',async()=>{
 const pool=poolFor({arrived:true});const data={clinicId:'4',doctorId:'6',userId:'33',bookingId:'17',action:'start',complaint:'ألم في ضرس علوي'};
 assert.equal((await svc.doctorAction(pool,data)).status,'ok');
 assert(pool.calls.some(c=>c.sql.includes('INSERT INTO sdc."VISIT"')&&c.params[0]==='ألم في ضرس علوي'&&c.params[1]==='17'));
 assert(pool.calls.some(c=>c.sql.includes('UPDATE sdc."BOOKING" SET "Booking_Status"=\'in_progress\'')));
 const retry=poolFor({arrived:true,status:'in_progress',visit_id:'12'});
 assert.equal((await svc.doctorAction(retry,data)).status,'ok');
 assert(!retry.calls.some(c=>c.sql.includes('INSERT INTO sdc."VISIT"')));
});
test('completed visit requires real clinical notes and preserves one visit per booking',async()=>{
 let pool=poolFor({arrived:true,status:'in_progress',visit_id:'19',visit_status:'in_progress',chief_complaint:'ألم',examination_notes:null});
 let result=await svc.doctorAction(pool,{clinicId:'4',doctorId:'6',userId:'33',bookingId:'17',action:'complete'});
 assert.equal(result.status,'incomplete');
 pool=poolFor({arrived:true,status:'in_progress',visit_id:'19',visit_status:'in_progress',chief_complaint:'ألم',examination_notes:null});
 result=await svc.doctorAction(pool,{clinicId:'4',doctorId:'6',userId:'33',bookingId:'17',action:'complete',examination:'فحص بالمرايا مع اختبار حيوية'});
 assert.equal(result.status,'ok');
 assert(pool.calls.some(c=>c.sql.includes('UPDATE sdc."VISIT"')&&c.params[3]==='completed'));
 assert(pool.calls.some(c=>c.sql.includes('UPDATE sdc."BOOKING" SET "Booking_Status"=\'completed\'')));
});
test('clinic daily operations and doctor visits preserve original pages and avoid fake patient medical notes',()=>{
 const fs=require('node:fs');const path=require('node:path');const root=path.resolve(__dirname,'..');
 const operations=fs.readFileSync(path.join(root,'views/clinic/operations.ejs'),'utf8');
 const visit=fs.readFileSync(path.join(root,'views/doctor/visit.ejs'),'utf8');
 assert(operations.includes('include(\'../partials/clinic/header\')'));
 assert(operations.includes('class="stat-card"'));
 assert(operations.includes('entries'));
 assert(!operations.includes('data-ui-pending=""'));
 assert(visit.includes('liveVisit.patient_name'));
 assert(visit.includes('liveVisit.health_notes'));
 assert(visit.includes('لم تُعرض هنا أي نتائج')===false || visit.includes('تجريبية'));
});
