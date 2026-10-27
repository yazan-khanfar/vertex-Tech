'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const svc=require('../src/clinic-clinical-service');
test('clinic clinical identifiers must be positive numeric strings',()=>{
 for(const id of ['1','208','9000123'])assert.equal(svc.validId(id),true);
 for(const id of ['',null,'0','-1','1 OR 1=1','1.2','abc','1'.repeat(19)])assert.equal(svc.validId(id),false);
});
test('stage progress handles empty, complete and partial stages',()=>{
 assert.equal(svc.safeRate(0,0),0);
 assert.equal(svc.safeRate(1,3),33);
 assert.equal(svc.safeRate(3,3),100);
});
test('follow-up status distinguishes waiting, overdue, booked and cancelled',()=>{
 assert.equal(svc.resolveRecall({suggested_date:'2026-11-01'},'2026-10-27'),'waiting');
 assert.equal(svc.resolveRecall({suggested_date:'2026-10-26'},'2026-10-27'),'overdue');
 assert.equal(svc.resolveRecall({suggested_date:'2026-11-01',follow_booking_id:'9',follow_booking_status:'confirmed'},'2026-10-27'),'booked');
 assert.equal(svc.resolveRecall({suggested_date:'2026-11-01',follow_booking_id:'9',follow_booking_status:'cancelled'},'2026-10-27'),'cancelled');
});
test('plans query is clinic-scoped and derives progress from real stages',async()=>{
 const queries=[];const pool={async query(sql,params){queries.push([sql,params]);return {rows:[{id:'8',title:'خطة',patient_name:'مريض',doctor_name:'طبيب',done:1,stages:3,status:'active'}]};}};
 const rows=await svc.listPlans(pool,'7');assert.equal(rows[0].progress,33);
 assert.deepEqual(queries[0][1],['7']);assert.match(queries[0][0],/p\."Clinic_ID"=\$1::bigint/);
});
test('plan details invalid id skips DB; missing or cross-clinic id returns null',async()=>{
 let calls=0;const pool={async query(sql,params){calls++;assert.deepEqual(params,['3','9']);return {rows:[]};}};
 assert.equal(await svc.planDetails(pool,'3','wrong'),null);assert.equal(calls,0);
 assert.equal(await svc.planDetails(pool,'3','9'),null);assert.equal(calls,1);
});
test('plan detail stages display accurate totals with the existing original template data shape',async()=>{
 let i=0;const pool={async query(sql,params){i++; if(i===1)return {rows:[{id:'9',status:'active',name:'خطة'}]};
 if(sql.includes('TREATMENT_STAGE'))return {rows:[{status:'completed'},{status:'planned'}]};
 return {rows:[{id:'123',date:'2026-11-01',time:'10:00'}]};}};
 const plan=await svc.planDetails(pool,'3','9');assert.equal(plan.progress,50);assert.equal(plan.next.id,'123');
});
test('completed visit rejects invalid, unavailable, foreign and non-completed records',async()=>{
 let calls=0;const pool={async query(sql,params){calls++;assert.match(sql,/b\."Clinic_ID"=\$1::bigint/);assert.match(sql,/b\."Booking_Status"='completed'/);assert.deepEqual(params,['4','6']);return {rows:[]};}};
 assert.equal(await svc.completedVisit(pool,'4','a'),null);assert.equal(calls,0);
 assert.equal(await svc.completedVisit(pool,'4','6'),null);assert.equal(calls,1);
});
test('unapproved report must never query diagnoses or files',async()=>{
 let calls=0;const pool={async query(){calls++;return {rows:[{approved:false,report_ref:null}]};}};
 assert.equal(await svc.reportDetails(pool,'4','6'),null);assert.equal(calls,1);
});
test('approved report fetches clinical record only after authorized visit check',async()=>{
 let calls=0;const pool={async query(sql){calls++; if(calls===1)return {rows:[{approved:true,report_ref:'private-file'}]};
 return {rows:[{name:'test'}]};}};
 const report=await svc.reportDetails(pool,'4','6');assert.equal(report.files.length,1);assert.equal(calls,5);
});
test('follow-up list is scoped by booking clinic and never trusts request patient id',async()=>{
 const pool={async query(sql,params){assert.match(sql,/b\."Clinic_ID"=\$1::bigint/);assert.deepEqual(params,['4']);return {rows:[{id:'4',suggested_date:'2026-10-30'}]};}};
 const rows=await svc.listRecalls(pool,'4','2026-10-27');assert.equal(rows[0].status,'waiting');
});
