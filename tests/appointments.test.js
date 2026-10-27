'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const s=require('../src/appointments/service');const schedule=require('../src/appointments/schedule');
function tomorrow(days=7){const date=new Date(Date.now()+days*86400000);return date.toISOString().slice(0,10);}
const choice={clinic_id:'4',doctor_id:'7',service_id:'9',duration:60,price:'200.00'};
function dbStub(config={}){const calls=[];const db={calls,async query(sql,params){calls.push({sql,params});
 if(sql.includes('FROM sdc."WORKS_AT"')&&sql.includes('"Start_Date"'))return {rowCount:1,rows:[{one:1}]};
 if(sql.includes('FROM sdc."DOCTOR_WORKING_HOURS"'))return {rows:config.weekly||[{start:'09:00',end:'13:00'}],rowCount:(config.weekly||[{start:'09:00',end:'13:00'}]).length};
 if(sql.includes('FROM sdc."CLINIC_WORKING_HOURS"'))return {rows:config.clinic||[{start:'10:00',end:'15:00'}]};
 if(sql.includes('FROM sdc."CLINIC_WORKING_EXCEPTIONS"'))return {rows:config.exceptions||[],rowCount:(config.exceptions||[]).length};
 if(sql.includes('FROM sdc."DOCTOR_ABSENCES"'))return {rows:[],rowCount:config.absence?1:0};
 if(sql.includes('FROM sdc."BOOKING"'))return {rows:config.busy||[],rowCount:(config.busy||[]).length};
 return {rows:[],rowCount:0};}};return db;}
test('validates dates and IDs, disallows past and malformed times',()=>{assert.equal(s.num('7'),'7');assert.equal(s.num('0'),null);assert.equal(s.dateValid('2026-02-30'),false);assert.equal(s.dateValid('2026-02-28'),true);assert.equal(s.dateValid('2026-02-28;DROP'),false);assert.equal(s.VALID_TIME.test('10:15'),false);assert.equal(s.VALID_TIME.test('10:30'),true);assert.equal(s.future('2020-01-01','12:00'),false);});
test('slots intersect doctor and clinic hours, and exclude doctor/patient overlapping appointments',async()=>{
 const db=dbStub({busy:[{start:'10:30',duration:60}]});
 assert.deepEqual(await s.slots(db,choice,tomorrow()),['11:30','12:00']);
 const busy=db.calls.find(x=>x.sql.includes('"Duration_Minutes_Snapshot" AS duration'));
 assert.equal(busy.params[1],'7');assert.equal(busy.params.length,4);
 const week=db.calls.find(x=>x.sql.includes('FROM sdc."DOCTOR_WORKING_HOURS"'));
 assert.equal(week.params.length,3); // no missing SQL parameters causing 42P08
});
test('slots reject clinic closure, doctor absence and empty schedule',async()=>{
 assert.deepEqual(await s.slots(dbStub({exceptions:[{type:'closed',start:null,end:null}]}),choice,tomorrow()),[]);
 assert.deepEqual(await s.slots(dbStub({absence:true}),choice,tomorrow()),[]);
 assert.deepEqual(await s.slots(dbStub({weekly:[]}),choice,tomorrow()),[]);
});
test('custom hours override weekly clinic hours; overlap respects duration snapshot',async()=>{
 const db=dbStub({exceptions:[{type:'custom_hours',start:'11:00',end:'12:00'}]});
 assert.deepEqual(await s.slots(db,choice,tomorrow()),['11:00']);
});
test('clinic doctor schedule validates inputs before obtaining database transaction',async()=>{
 let queried=false;const pool={connect(){queried=true;throw Error('not expected');}};
 assert.deepEqual(await schedule.save(pool,'4','7','2',{action:'add_period',day:8,start:'09:00',end:'12:00'}),{status:'invalid'});
 assert.deepEqual(await schedule.save(pool,'4','7','2',{action:'add_absence',from_date:'2026-09-31',to_date:'2026-10-01',reason:'test'}),{status:'invalid'});
 assert.equal(queried,false);
});
test('booking rejects invalid times, invalid clinic or malicious notes before DB access',async()=>{
 const pool={connect(){throw Error('pool not permitted');}};
 const actor={role:'patient',userId:'10'};
 const base={appointment_date:tomorrow(),appointment_time:'10:15',clinic_id:'4',doctor_id:'7',service_id:'9'};
 assert.deepEqual(await s.book(pool,base,actor,null),{status:'invalid'});
 assert.deepEqual(await s.book(pool,{...base,appointment_time:'10:30',notes:'A'.repeat(2001)},actor,null),{status:'invalid'});
});
test('all status actions require scoped booking ID and approved operation name',async()=>{
 const pool={connect(){throw Error('no access');}};
 assert.deepEqual(await s.action(pool,{role:'patient',userId:'10'},null,{action:'admin_override',booking_id:'12'}),{status:'invalid'});
 assert.deepEqual(await s.action(pool,{role:'patient',userId:'10'},null,{action:'confirm',booking_id:'bad'}),{status:'invalid'});
});

test('availability explains why weekly days cannot be booked; closure always wins',async()=>{
 const date=tomorrow();
 let result=await s.availability(dbStub({weekly:[{start:'09:00',end:'13:00'}],clinic:[{start:'10:00',end:'15:00'}]}),choice,date);
 assert.equal(result.reason,'available');assert(result.slots.length>0);
 result=await s.availability(dbStub({exceptions:[{type:'closed',start:null,end:null}]}),choice,date);
 assert.deepEqual(result,{slots:[],reason:'clinic_closed'});
 result=await s.availability(dbStub({exceptions:[{type:'custom_hours',start:'11:00',end:'12:00'}]}),choice,date);
 assert.deepEqual(result,{slots:['11:00'],reason:'available'});
 result=await s.availability(dbStub({weekly:[]}),choice,date);assert.equal(result.reason,'doctor_no_hours');
 result=await s.availability(dbStub({clinic:[]}),choice,date);assert.equal(result.reason,'clinic_no_hours');
 result=await s.availability(dbStub({clinic:[{start:'15:00',end:'16:00'}]}),choice,date);assert.equal(result.reason,'no_overlap');
 result=await s.availability(dbStub({absence:true}),choice,date);assert.equal(result.reason,'doctor_absent');
});

test('booking templates explain unavailable slots without replacing existing layout',()=>{
 const fs=require('node:fs');const path=require('node:path');const root=path.resolve(__dirname,'..');
 for(const file of ['patient/book-appointment','clinic/new-appointment']){
  const ejs=fs.readFileSync(path.join(root,'views',file+'.ejs'),'utf8');
  assert(ejs.includes('availabilityMessage'));
 }
 const clinic=fs.readFileSync(path.join(root,'views/clinic/new-appointment.ejs'),'utf8');
 assert.equal((clinic.match(/id="searchClinicSlots"/g)||[]).length,1);
 assert.equal((clinic.match(/form="searchClinicSlots">عرض الأوقات المتاحة/g)||[]).length,1);
});

// Regression: a clinic cannot reject silently, and patient receives the stored reason.
test('reject requires a nonblank reason and limits its length before database access',async()=>{
 const pool={connect(){throw Error('database must not be accessed for invalid rejection');}};
 const actor={role:'doctor',userId:'2',doctorId:'7',isManager:true};
 assert.deepEqual(await s.action(pool,actor,'4',{action:'reject',booking_id:'17'}),{status:'reason_required'});
 assert.deepEqual(await s.action(pool,actor,'4',{action:'reject',booking_id:'17',reason:'  '}),{status:'reason_required'});
 assert.deepEqual(await s.action(pool,actor,'4',{action:'reject',booking_id:'17',reason:'x'.repeat(2001)}),{status:'reason_required'});
});
test('reject stores reason in booking notes, audit and patient notification',async()=>{
 const calls=[];
 const booking={id:'17',date:tomorrow(),time:'10:00',status:'pending',request_status:null,clinic_id:'4',doctor_id:'7',patient_id:'15'};
 const db={async query(sql,params){calls.push({sql,params});
  if(sql.includes('FROM sdc."BOOKING" WHERE "Booking_ID"'))return {rowCount:1,rows:[{Doctor_ID:7}]};
  if(sql.includes('FROM sdc."DOCTOR"')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[{}]};
  if(sql.includes('FROM sdc."BOOKING" b')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[booking]};
  if(sql.includes('FROM sdc."PATIENT" WHERE "Patient_ID"'))return {rowCount:1,rows:[{id:'99'}]};
  return {rowCount:1,rows:[]};
 },release(){}};
 const pool={connect:async()=>db};
 const result=await s.action(pool,{role:'doctor',userId:'2',doctorId:'7',isManager:true},'4',{action:'reject',booking_id:'17',reason:'الطبيب غير متاح'});
 assert.equal(result.status,'ok');
 const update=calls.find(x=>x.sql.includes('"Administrative_Notes"=$2::text'));
 assert(update,'reason should be persisted in BOOKING');
 assert.deepEqual(update.params,['17','الطبيب غير متاح']);
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."AUDIT_LOG"')&&x.params.includes('الطبيب غير متاح')));
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."NOTIFICATION"')&&x.params.some(v=>typeof v==='string'&&v.includes('الطبيب غير متاح'))));
});
test('original clinic details modal requires reason and patient details displays it',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const root=path.resolve(__dirname,'..');
 const clinic=fs.readFileSync(path.join(root,'views/clinic/appointment-details.ejs'),'utf8');
 const patient=fs.readFileSync(path.join(root,'views/patient/booking-details.ejs'),'utf8');
 assert(clinic.includes('id="clinicRejectAppointmentModal"'));
 assert(clinic.includes('id="clinicBookingRejectionReason" name="reason"'));
 assert(clinic.includes('name="action" value="reject"'));
 assert(clinic.includes('data-bs-target="#clinicRejectAppointmentModal"'));
 assert(patient.includes('booking.administrative_notes'));
 assert(patient.includes('سبب رفض الموعد'));
});

function schedulePool({overlap=false,affected=false,stale=false,dbError=null}={}){
 const calls=[];
 const db={async query(sql,params=[]){calls.push({sql,params});
  if(dbError&&sql.includes('UPDATE sdc."DOCTOR_WORKING_HOURS"'))throw Object.assign(new Error('constraint'),{code:dbError});
  if(sql.includes('FROM sdc."WORKS_AT"')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[{}]};
  if(sql.includes('FROM sdc."DOCTOR_WORKING_HOURS" WHERE')&&sql.includes('FOR UPDATE'))return {rowCount:stale?0:1,rows:stale?[]:[{}]};
  if(sql.includes('SELECT 1 FROM sdc."DOCTOR_WORKING_HOURS" h')&&sql.includes('NOT ($5'))return {rowCount:overlap?1:0,rows:[]};
  if(sql.includes('SELECT 1 FROM sdc."BOOKING" b')&&sql.includes('EXTRACT(DOW'))return {rowCount:affected?1:0,rows:[]};
  if(sql.startsWith('UPDATE sdc."DOCTOR_WORKING_HOURS"'))return {rowCount:1};
  return {rowCount:1,rows:[{}]};
 },release(){calls.push({sql:'RELEASE'})}};
 return {calls,async connect(){return db}};
}
const editSchedule={action:'update_period',original_day:'0',original_start:'12:27',original_end:'18:27',day:'0',start:'13:00',end:'19:00',active:'true'};
test('edit doctor schedule updates existing PK row atomically with audit rather than delete/reinsert',async()=>{
 const pool=schedulePool();
 assert.deepEqual(await schedule.save(pool,'4','7','2',editSchedule),{status:'ok'});
 const update=pool.calls.find(x=>x.sql.startsWith('UPDATE sdc."DOCTOR_WORKING_HOURS"'));
 assert(update);assert.deepEqual(update.params,['4','7',0,'12:27','18:27',0,'13:00','19:00',true]);
 assert(pool.calls.some(x=>x.sql==='COMMIT'));
 assert(pool.calls.some(x=>x.sql.includes('INSERT INTO sdc."AUDIT_LOG"')&&x.params[0]==='doctor.schedule.update_period'));
 assert(!pool.calls.some(x=>x.sql.includes('DELETE FROM sdc."DOCTOR_WORKING_HOURS"')));
});
test('edit blocks overlapping doctor hours across clinics and protects existing bookings',async()=>{
 for(const [opts,expected] of [[{overlap:true},'conflict'],[{affected:true},'bookings_affected'],[{stale:true},'stale']]){
  const pool=schedulePool(opts);
  assert.deepEqual(await schedule.save(pool,'4','7','2',editSchedule),{status:expected});
  assert(pool.calls.some(x=>x.sql==='ROLLBACK'));
  assert(!pool.calls.some(x=>x.sql.startsWith('UPDATE sdc."DOCTOR_WORKING_HOURS"')));
 }
 const pool=schedulePool({dbError:'23514'});
 assert.deepEqual(await schedule.save(pool,'4','7','2',editSchedule),{status:'conflict'});
 assert(pool.calls.some(x=>x.sql==='ROLLBACK'));
});
test('editing validates input and allows 24:00 and inactive periods',async()=>{
 let called=false;const pool={connect(){called=true;throw Error('No DB expected');}};
 assert.deepEqual(await schedule.save(pool,'4','7','2',{...editSchedule,start:'19:00',end:'13:00'}),{status:'invalid'});
 assert.deepEqual(await schedule.save(pool,'4','7','2',{...editSchedule,original_start:'bad'}),{status:'invalid'});
 assert.deepEqual(await schedule.save(pool,'4','7','2',{...editSchedule,active:'wat'}),{status:'invalid'});
 assert.equal(called,false);
 const okay=schedulePool();
 assert.deepEqual(await schedule.save(okay,'4','7','2',{...editSchedule,start:'00:00',end:'',end_of_day:'on',active:'false'}),{status:'ok'});
 assert.equal(okay.calls.find(x=>x.sql.startsWith('UPDATE sdc."DOCTOR_WORKING_HOURS"')).params[7],'24:00');
 assert.equal(okay.calls.find(x=>x.sql.startsWith('UPDATE sdc."DOCTOR_WORKING_HOURS"')).params[8],false);
});
test('schedule edit preserves the original doctor-details page, using its existing modal',()=>{
 const fs=require('node:fs'),path=require('node:path');const root=path.resolve(__dirname,'..');
 const html=fs.readFileSync(path.join(root,'views/clinic/doctor-details.ejs'),'utf8');
 const js=fs.readFileSync(path.join(root,'public/clinic/assets/app.js'),'utf8');
 assert(html.includes('data-schedule-edit'));
 assert.equal((html.match(/id="schedulePeriodModal"/g)||[]).length,1);
 assert.equal((html.match(/id="realScheduleForm"/g)||[]).length,1);
 assert(html.includes('name="original_day"'));
 assert(js.includes("'update_period'"));
});
