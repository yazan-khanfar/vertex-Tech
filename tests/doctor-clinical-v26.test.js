'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const svc=require('../src/doctor-workspace/clinical-service');
const c={id:'20',doc:'10',user:'3'};
function mockTx(fn){const calls=[];const conn={async query(sql,args=[]){calls.push({sql,args});return fn(sql,args,calls)}};return {calls,pool:{async connect(){return {...conn,release(){}}}}};}
const ok={rowCount:1,rows:[]};
test('patient and plan input are validated before DB writes',async()=>{
 const db=mockTx(()=>{throw Error('unexpected query');});
 await assert.rejects(()=>svc.createPlan(db.pool,c,{new_plan_patient:'P-2',new_plan_name:'Treatment',new_plan_first_step:'Phase',new_plan_status:'active'}),{status:422});
 assert.equal(db.calls.length,0);
 await assert.rejects(()=>svc.createPlan(db.pool,c,{new_plan_patient:'1',new_plan_name:'Treatment',new_plan_first_step:'Phase',new_plan_status:'paused'}),{status:422});
});
test('create plan and first stage are atomic and use doctor+clinic+patient scoping',async()=>{
 const f=mockTx((sql,args)=>sql.includes('FROM sdc."BOOKING"')?{rowCount:1,rows:[{}]}:sql.includes('RETURNING "Plan_ID"')?{rowCount:1,rows:[{id:'87'}]}:ok);
 const out=await svc.createPlan(f.pool,c,{new_plan_patient:'5',new_plan_name:'Plan',new_plan_first_step:'First stage',new_plan_status:'active',new_plan_tooth:'46',new_plan_cost:'120.20'});
 assert.equal(out.id,'87');assert(f.calls.some(x=>x.sql.includes('"Doctor_ID"=$1::bigint')&&x.sql.includes('"Clinic_ID"=$2::bigint')&&x.sql.includes('"Patient_ID"=$3::bigint')));
 assert(f.calls.some(x=>x.sql.includes('INSERT INTO sdc."TREATMENT_STAGE"')));assert.equal(f.calls.at(-1).sql,'COMMIT');
});
test('does not create a plan for a patient without doctor-specific appointment',async()=>{
 const f=mockTx((sql)=>sql.includes('FROM sdc."BOOKING"')?{rowCount:0,rows:[]}:ok);
 await assert.rejects(()=>svc.createPlan(f.pool,c,{new_plan_patient:'5',new_plan_name:'Plan',new_plan_first_step:'First stage',new_plan_status:'active'}),{status:403});
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert(!f.calls.some(x=>x.sql.includes('INSERT INTO sdc."TREATMENT_PLAN"')));
});
test('rejects foreign treatment plan before update',async()=>{
 const f=mockTx((sql)=>sql.includes('SELECT p."Plan_ID"')?{rowCount:0,rows:[]}:ok);
 await assert.rejects(()=>svc.changePlan(f.pool,c,{action:'add_stage',plan_id:'501',description:'Treatment'}),{status:404});
 assert(f.calls.some(x=>x.sql.includes('p."Doctor_ID"=$1::bigint')&&x.sql.includes('p."Clinic_ID"=$2::bigint')));
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
test('tooth selection follows FDI rules and is a single-tooth value',()=>{
 for(const n of ['11','18','28','37','46','55','85'])assert.equal(svc.tooth(n),Number(n));
 for(const n of ['0','49','88','3','11,12','abc','19'])assert.throws(()=>svc.tooth(n),{status:422});
 assert.equal(svc.tooth(''),null);
});
test('clinical write refuses visits outside doctor clinic and rolls back',async()=>{
 const f=mockTx((sql)=>sql.includes('FROM sdc."VISIT" v JOIN')?{rowCount:0,rows:[]}:ok);
 await assert.rejects(()=>svc.clinicalAction(f.pool,c,{booking_id:'666',action:'odontogram',tooth_number:'46',tooth_status:'healthy'}),{status:404});
 assert(f.calls.some(x=>x.sql.includes('b."Doctor_ID"=$2::bigint')&&x.sql.includes('b."Clinic_ID"=$3::bigint')));
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
test('approved report cannot receive new diagnoses',async()=>{
 const f=mockTx((sql)=>sql.includes('FROM sdc."VISIT" v JOIN')?{rowCount:1,rows:[{id:'4',approved:'2026-10-25',status:'completed'}]}:ok);
 await assert.rejects(()=>svc.clinicalAction(f.pool,c,{booking_id:'9',action:'diagnosis',tooth_number:'46',diagnosis:'Text'}),{status:409});
 assert(!f.calls.some(x=>x.sql.includes('INSERT INTO sdc."VISIT_DIAGNOSES"')));
});
test('odontogram save uses one FDI tooth and ON CONFLICT upsert',async()=>{
 const f=mockTx((sql)=>sql.includes('FROM sdc."VISIT" v JOIN')?{rowCount:1,rows:[{id:'4',approved:null,status:'in_progress'}]}:ok);
 await svc.clinicalAction(f.pool,c,{booking_id:'9',action:'odontogram',tooth_number:'46',tooth_status:'caries'});
 const q=f.calls.find(x=>x.sql.includes('INSERT INTO sdc."VISIT_ODONTOGRAM"'));assert(q);assert.deepEqual(q.args,['4',46,'caries']);assert(q.sql.includes('ON CONFLICT'));
 assert.equal(f.calls.at(-1).sql,'COMMIT');
});
test('a procedure only uses assigned doctor services and booking visit',async()=>{
 const f=mockTx((sql)=>sql.includes('FROM sdc."VISIT" v JOIN')?{rowCount:1,rows:[{id:'4',approved:null,status:'in_progress'}]}:sql.includes('FROM sdc."OFFERS" o JOIN sdc."PROVIDES"')?{rowCount:0,rows:[]}:ok);
 await assert.rejects(()=>svc.clinicalAction(f.pool,c,{booking_id:'9',action:'procedure',service_id:'8',quantity:'1'}),{status:403});
 assert(!f.calls.some(x=>x.sql.includes('INSERT INTO sdc."PROCEDURE"')));
});
test('writes parser is scoped to exact clinical POST paths and enforces CSRF',()=>{
 const router=fs.readFileSync(path.join(__dirname,'../src/doctor-workspace/clinical-router.js'),'utf8');
 assert(router.includes("withForm('/visit/clinical/action'"));assert(router.includes("withForm('/treatment-plans/create'"));
 assert(router.includes('validateSessionCsrf(req)'));assert(!router.includes('router.use(form)'));
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert(server.indexOf("guard('doctor')")<server.indexOf("require('./src/doctor-workspace/clinical-router')"));
});
