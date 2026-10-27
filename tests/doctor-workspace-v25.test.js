'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const root=path.join(__dirname,'..');
const svc=require('../src/doctor-workspace/service');
function db(handler){const calls=[];return {calls,pool:{async query(sql,args){calls.push({sql,args});return handler?.(sql,args)??{rows:[]};}}};}
test('doctor patient list always limits visibility by BOTH assigned doctor and clinic',async()=>{
 const f=db(()=>({rows:[{id:'7',name:'مريض اختبار',dob:'2000-01-01',last_visit:null}]}));
 const out=await svc.patients(f.pool,'10','20');assert.equal(out.length,1);
 assert.equal(out[0].id,'7');assert.deepEqual(f.calls[0].args,['10','20']);
 assert(f.calls[0].sql.includes('own."Doctor_ID"=$1::bigint AND own."Clinic_ID"=$2::bigint'));
 assert(f.calls[0].sql.includes('TREATMENT_PLAN'));
});
test('reject arbitrary patient identifiers without executing any queries',async()=>{
 const f=db(()=>{throw Error('Unexpected query')});
 assert.equal(await svc.patientDetails(f.pool,'10','20','10 OR TRUE'),null);
 assert.equal(await svc.patientDetails(f.pool,'10','20','ahmad'),null);
 assert.equal(f.calls.length,0);
});
test('doctor patient details reject absent/unrelated patient before reading health data',async()=>{
 const f=db(()=>({rows:[]}));
 assert.equal(await svc.patientDetails(f.pool,'10','20','9'),null);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].args,['10','20','9']);
 assert(f.calls[0].sql.includes('p."Patient_ID"=$3::bigint'));
 assert(f.calls[0].sql.includes('own."Doctor_ID"=$1::bigint AND own."Clinic_ID"=$2::bigint'));
});
test('follow-up read models only include completed visits for the authenticated doctor and clinic',async()=>{
 const f=db(()=>({rows:[{id:'1',date:'2026-12-25',name:'اختبار',booked_id:null,type:'مراجعة'}]}));
 const out=await svc.followups(f.pool,'3','4');assert.equal(out[0].status,'waiting');
 assert(f.calls[0].sql.includes('b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint'));
 assert(f.calls[0].sql.includes('b."Booking_Status"=\'completed\''));
});
test('the new doctor routes are mounted after doctor guard and before preview fallback',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const guard=server.indexOf("app.use('/doctor',guard('doctor'))");
 const mount=server.indexOf("app.use('/doctor',require('./src/doctor-workspace/router'))");
 const preview=server.indexOf('app.get([\'/\', /^\\/(?:.+\\/)?[^/]+$/], renderPage)');
 assert(guard>=0&&mount>guard&&preview>mount);
 const router=fs.readFileSync(path.join(root,'src/doctor-workspace/router.js'),'utf8');
 assert(router.includes('req.sdcClinics?.some(c=>c.id===id)'));
 assert(router.includes('res.sendStatus(404)'));
});
test('doctor workspace has original role header/footer and live data bindings',()=>{
 for(const page of ['index','patients','patient-details','followups']){
  const html=fs.readFileSync(path.join(root,'views/doctor',page+'.ejs'),'utf8');
  assert(html.includes("partials/doctor/header"));assert(html.includes("partials/doctor/footer"));
  assert(!html.includes('21 أكتوبر 2026'),page+' retains fabricated visit date');
  assert(!html.includes('P-2048'),page+' retains fabricated patient number');
 }
 const schedule=fs.readFileSync(path.join(root,'views/doctor/schedule.ejs'),'utf8');
 assert(schedule.includes('profile.absences.length'));
 assert(!schedule.includes('مؤتمر علمي'));
});

test('plan details do not reveal cross-doctor or cross-clinic plans',async()=>{
 const f=db(()=>({rows:[]}));
 assert.equal(await svc.treatmentPlanDetails(f.pool,'2','3','4'),null);
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].args,['2','3','4']);
 assert(f.calls[0].sql.includes('t."Doctor_ID"=$1::bigint AND t."Clinic_ID"=$2::bigint AND t."Plan_ID"=$3::bigint'));
});
test('plan list only returns records from selected doctor and clinic',async()=>{
 const f=db(()=>({rows:[{id:'5',total:3,done:2,title:'خطة'}]}));
 const plans=await svc.treatmentPlans(f.pool,'2','3');
 assert.equal(plans[0].progress,67);
 assert.deepEqual(f.calls[0].args,['2','3']);
});
