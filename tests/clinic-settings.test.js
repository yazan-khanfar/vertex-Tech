'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const svc=require('../src/clinic-settings-service');
const root=path.resolve(__dirname,'..');
test('only selected manager clinic is writable',()=>{
 const req={sdcActor:{role:'doctor'},sdcSession:{clinicId:'12'},sdcClinics:[{id:'12',manager:true},{id:'13',manager:false}]};
 assert.equal(svc.clinicId(req),'12');
 assert.equal(svc.clinicId({...req,sdcSession:{clinicId:'13'}}),null);
 assert.equal(svc.clinicId({...req,sdcActor:{role:'patient'}}),null);
 assert.equal(svc.clinicId({...req,sdcClinics:[]}),null);
});
test('profile requires valid contact and geocoordinates',()=>{
 const original={name:'عيادة الفحص',phone:'0590000000',email:'clinic@example.test',city:'جنين',area:'وسط المدينة',address:'العنوان الرئيسي',description:'',latitude:'32.45960',longitude:'35.30090'};
 assert(svc.checkProfile(original));
 for(const b of [{latitude:'91'},{longitude:'-182'},{city:''},{email:'wrong'},{name:''},{latitude:''}])assert.equal(svc.checkProfile({...original,...b}),null);
});
test('weekly hours reject overlap, invalid ranges and duplicate rows',()=>{
 const valid=[{day:6,start:'09:00',end:'12:00'},{day:6,start:'13:00',end:'17:00'},{day:0,start:'09:00',end:'17:00'}];
 assert.equal(svc.checkHours(JSON.stringify(valid)).length,3);
 for(const bad of [
  [{day:6,start:'09:00',end:'12:00'},{day:6,start:'11:59',end:'17:00'}],
  [{day:5,start:'14:00',end:'13:00'}],
  [{day:8,start:'09:00',end:'12:00'}],
  [valid[0],valid[0]]])assert.equal(svc.checkHours(JSON.stringify(bad)),null);
});
test('exceptions reject closed day mixed with hours or overlapped periods',()=>{
 const closed={date:'2026-11-15',type:'closed',reason:'إجازة رسمية',start:'',end:''};
 assert.deepEqual(svc.checkExceptions(JSON.stringify([closed])),[closed]);
 const custom={...closed,type:'custom_hours',start:'10:00',end:'12:00'};
 assert.equal(svc.checkExceptions(JSON.stringify([closed,custom])),null);
 assert.equal(svc.checkExceptions(JSON.stringify([custom,{...custom,start:'11:00',end:'14:00'}])),null);
});
test('service validation blocks fabricated doctor IDs, bad prices and durations',()=>{
 const raw={service_id:'12',price:'250.00',duration:'45',installments:'false',available:'true',doctor_ids:['2','3']};
 assert(svc.checkService(raw));
 for(const b of [{service_id:'S-12'},{price:'-30'},{duration:'0'},{doctor_ids:['1','1']},{doctor_ids:['x']},{available:'on'}])assert.equal(svc.checkService({...raw,...b}),null);
});
function fakePool(){const queries=[];const client={async query(sql,args=[]){queries.push({sql,args});
  if(sql.includes('SELECT "Clinic_ID" FROM sdc."CLINIC"'))return {rowCount:1,rows:[{Clinic_ID:'5'}]};
  if(sql.includes('SELECT 1 FROM sdc."SERVICE"'))return {rowCount:1,rows:[{}]};
  if(sql.includes('SELECT "Doctor_ID"::text AS id'))return {rowCount:1,rows:[{id:'3'}]};
  if(sql.includes('SELECT b."Booking_ID" FROM sdc."BOOKING"')||sql.includes('SELECT "Booking_ID" FROM sdc."BOOKING"'))return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};},release(){queries.push({sql:'RELEASE'})}};
 return {queries,async connect(){return client}};
}
test('service edit preserves unchanged PROVIDES links and records audit atomically',async()=>{
 const pool=fakePool();const result=await svc.saveService(pool,'5','3',{service_id:'21',price:'100',duration:'30',installments:'false',available:'true',doctor_ids:['3']});
 assert.equal(result.status,'ok');
 assert(pool.queries.some(r=>r.sql.includes('INSERT INTO sdc."OFFERS"')));
 assert(!pool.queries.some(r=>r.sql.startsWith('DELETE FROM sdc."PROVIDES"')));
 assert(pool.queries.some(r=>r.sql.includes('AUDIT_LOG')));assert(pool.queries.some(r=>r.sql==='COMMIT'));
});
test('profile update uses authenticated actor and transaction without changing license',async()=>{
 const pool=fakePool();const result=await svc.change(pool,'5','3','details',{name:'عيادة الفحص',phone:'0590000000',email:'clinic@example.test',city:'جنين',area:'وسط المدينة',address:'وسط البلد',description:'',latitude:'32.459',longitude:'35.3'});
 assert.equal(result.status,'ok');assert(pool.queries.some(r=>r.sql.includes("set_config('sdc.user_id'")&&r.args[0]==='3'));
 const update=pool.queries.find(r=>r.sql.includes('UPDATE sdc."CLINIC"'));assert(update&&!update.sql.includes('Facility_License_Number')&&!update.sql.includes('Approval_Status'));assert(pool.queries.some(r=>r.sql==='COMMIT'));
});
test('admin approvals include Bootstrap JS and existing header/dropdowns, no extra UI pages',()=>{
 for(const name of ['approvals','clinic-application-details']){
  const html=fs.readFileSync(path.join(root,'views/admin',name+'.ejs'),'utf8');
  assert(html.includes('/assets/vendor/8d95173bee2e-bootstrap.bundle.min.js'));
  assert(html.includes('/admin/assets/app.js'));
  assert(html.includes("include('../partials/admin/header')"));
 }
 const app=fs.readFileSync(path.join(root,'server.js'),'utf8');assert(app.includes("app.use('/clinic',require('./src/clinic-settings-router'))"));
 for(const name of ['profile','services']){
  const s=fs.readFileSync(path.join(root,'views/clinic',name+'.ejs'),'utf8');
  assert(s.includes('name="csrf_token"'));assert(s.includes('/clinic/'+name));assert(!s.includes('data-ui-unbound'));
 }
});

// A full-day clinic schedule is one PostgreSQL TIME interval, not 00:00–00:00.
test('clinic full-day schedule uses 00:00 to 24:00 without weakening overlap checks',()=>{
 const allDay={day:1,start:'00:00',end:'24:00'};
 assert.deepEqual(svc.checkHours(JSON.stringify([allDay])),[allDay]);
 assert.equal(svc.checkHours(JSON.stringify([{...allDay,end:'00:00'}])),null);
 assert.equal(svc.checkHours(JSON.stringify([{day:1,start:'22:00',end:'02:00'}])),null);
 assert.equal(svc.checkHours(JSON.stringify([{day:1,start:'11:00',end:'24:00'}])),null);
 assert.equal(svc.checkHours(JSON.stringify([allDay,{day:1,start:'12:00',end:'15:00'}])),null);
 assert(svc.checkHours(JSON.stringify(Array.from({length:7},(_,day)=>({...allDay,day})))));
});
test('clinic full-day choice is available in the existing profile UI, not a new page',()=>{
 const profile=fs.readFileSync(path.join(root,'views/clinic/profile.ejs'),'utf8');
 const ui=fs.readFileSync(path.join(root,'public/clinic/assets/app.js'),'utf8');
 assert(profile.includes('set-day-24h')&&profile.includes('setClinicWeek24h')&&profile.includes('data-full-day="true"'));
 assert(ui.includes('replaceChildren(makeFullDay())'));
 assert(ui.includes("end:'24:00'"));
});
test('clinic full-day hours persist through existing clinic-hours transaction',async()=>{
 const pool=fakePool();const payload=JSON.stringify([{day:6,start:'00:00',end:'24:00'}]);
 const r=await svc.change(pool,'5','3','hours',{hours_json:payload});
 assert.equal(r.status,'ok');
 assert(pool.queries.some(q=>q.sql.includes('INSERT INTO sdc."CLINIC_WORKING_HOURS"')&&q.args[2]==='24:00'));
 assert(pool.queries.some(q=>q.sql==='COMMIT'));
});

test('availability and patient clinic directory retain full-day 24:00 boundary',()=>{
 const booking=fs.readFileSync(path.join(root,'src/appointments/service.js'),'utf8');
 const directory=fs.readFileSync(path.join(root,'src/patient-directory-service.js'),'utf8');
 assert(booking.includes("CASE WHEN \"End_Time\"=TIME '24:00' THEN '24:00'"));
 assert(directory.includes("CASE WHEN \"End_Time\"=TIME '24:00' THEN '24:00'"));
});

// The clinic profile must not silently displace existing appointments.
test('invalid calendar dates in exceptions are rejected',()=>{
 const sample={date:'2026-02-31',type:'closed',reason:'إغلاق',start:'',end:''};
 assert.equal(svc.checkExceptions(JSON.stringify([sample])),null);
 assert(svc.checkExceptions(JSON.stringify([{...sample,date:'2028-02-29'}])));
});
test('weekly hours conflict rolls back atomically and is not saved',async()=>{
 const queries=[];let released=false;
 const pool={async connect(){return {async query(sql,args=[]){queries.push({sql,args});
  if(sql.startsWith('SELECT \"Clinic_ID\" FROM sdc.\"CLINIC\"'))return {rowCount:1,rows:[{Clinic_ID:'4'}]};
  if(sql.includes('SELECT b.\"Booking_ID\" FROM sdc.\"BOOKING\"'))return {rowCount:1,rows:[{Booking_ID:'82'}]};
  return {rowCount:0,rows:[]};},release(){released=true;}}}};
 const result=await svc.change(pool,'4','3','hours',{hours_json:JSON.stringify([{day:1,start:'10:00',end:'12:00'}])});
 assert.equal(result.status,'bookings_conflict');
 assert(queries.some(x=>x.sql==='ROLLBACK'));
 assert(!queries.some(x=>x.sql==='COMMIT'));
 assert(released);
});
test('disabling online booking respects pending AI appointments',async()=>{
 const queries=[];const pool={async connect(){return {async query(sql,args=[]){queries.push(sql);
  if(sql.startsWith('SELECT \"Clinic_ID\" FROM sdc.\"CLINIC\"'))return {rowCount:1,rows:[{Clinic_ID:'4'}]};
  if(sql.includes('SELECT \"Booking_ID\" FROM sdc.\"BOOKING\"'))return {rowCount:1,rows:[{Booking_ID:'8'}]};
  return {rowCount:0,rows:[]};},release(){}}}};
 const result=await svc.change(pool,'4','3','booking',{booking_enabled:''});
 assert.equal(result.status,'ai_pending');
 assert(queries.includes('ROLLBACK'));
 assert(!queries.includes('COMMIT'));
});
test('validation errors return to the original clinic profile, not a new page',()=>{
 const router=fs.readFileSync(path.join(root,'src/clinic-settings-router.js'),'utf8');
 assert(router.includes('bookings_conflict'));
 assert(router.includes('ai_pending'));
 assert(router.includes("res.status(conflict?409:503).render('clinic/profile'"));
});
