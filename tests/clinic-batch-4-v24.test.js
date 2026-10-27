'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const svc=require('../src/clinic-remaining-service');
const reports=require('../src/clinic-reports-service');
const root=path.join(__dirname,'..');
function fake(impl){const calls=[];let released=0;const db={async query(sql,args=[]){calls.push({sql,args});return impl(sql,args)||{rowCount:0,rows:[]};},release(){released++;}};return {pool:{connect:async()=>db},calls,released:()=>released};}
const job={clinic_job_title:'طبيب أسنان',clinic_job_hours:'الأحد - الخميس',clinic_job_salary:'بحسب الخبرة',clinic_job_description:'عيادتنا تبحث عن طبيب',clinic_job_responsibilities:'التعامل مع المرضى',clinic_job_requirements:'رخصة سارية',clinic_job_specialty:'17',clinic_job_type:'full_time',clinic_job_deadline:'2026-12-15',clinic_job_experience:'2',publish:'1'};
test('reject invalid IDs, dates, lab cases, job inputs without connecting',async()=>{
 const pool={connect(){throw Error('Must not connect for invalid data');}};
 for(const id of ['',null,'0','-8','7 AND 1=1','3.1','1'.repeat(19)])assert.equal(svc.validId(id),false);
 assert(!svc.date('2026-02-30'));
 assert.equal((await svc.changeLabCase(pool,'8','100','4','5','transfer','0')).status,'invalid');
 assert.equal((await svc.changeLabCase(pool,'8','100','4','5','delete','7')).status,'invalid');
 assert.equal((await svc.createLabCase(pool,'8','100','4',{visit_id:'3',work_type:'تقويم',delivery_date:'2020-01-01'})).status,'invalid');
 assert.equal((await svc.createLabCase(pool,'8','100','4',{visit_id:'3',work_type:'تقويم',delivery_date:'2099-01-01',tooth:'99'})).status,'invalid');
 assert.equal((await svc.saveJob(pool,'8','100',{...job,clinic_job_title:''})).status,'invalid');
 assert.equal((await svc.saveJob(pool,'8','100',{...job,clinic_job_deadline:'2026-02-30'})).status,'invalid');
 assert.equal((await svc.changeApplication(pool,'8','100','5',{status:'review'})).status,'invalid');
});
test('lab order missing in clinic cannot be changed even if ID exists elsewhere',async()=>{
 const {pool,calls,released}=fake(()=>({rowCount:0,rows:[]}));
 const result=await svc.changeLabCase(pool,'8','100','4','60','send');
 assert.equal(result.status,'not_found');
 const q=calls.find(x=>x.sql.includes('FOR UPDATE OF o'));
 assert(q.sql.includes('b."Clinic_ID"=$1::bigint'));
 assert.deepEqual(q.args,['8','4','60']);
 assert(calls.some(x=>x.sql==='ROLLBACK'));
 assert(!calls.some(x=>x.sql.startsWith('UPDATE sdc."LAB_ORDER"')));
 assert.equal(released(),1);
});
test('sending lab order requires draft status and an active linked laboratory',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FOR UPDATE OF o'))return {rowCount:1,rows:[{Order_Status:'draft'}]};
  if(sql.includes('FROM sdc."WORKS_WITH"'))return {rowCount:0,rows:[]};
 });
 assert.equal((await svc.changeLabCase(pool,'8','100','4','60','send')).status,'forbidden');
 assert(!calls.some(x=>x.sql.includes('SET "Order_Status"')));
});
test('only draft case can transfer and only into another active clinic laboratory',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FOR UPDATE OF o'))return {rowCount:1,rows:[{Order_Status:'draft'}]};
  if(sql.includes('FROM sdc."WORKS_WITH"'))return {rowCount:1,rows:[{'?column?':1}]};
 });
 const r=await svc.changeLabCase(pool,'8','100','4','60','transfer','7');
 assert.equal(r.status,'ok');assert(calls.some(x=>x.sql==='COMMIT'));
 const change=calls.find(x=>x.sql.includes('UPDATE sdc."LAB_ORDER"'));
 assert.deepEqual(change.args,['60','7']);
 assert(calls.some(x=>x.sql.includes('FROM sdc."WORKS_WITH"')&&x.args[0]==='8'));
});
test('lab case creation checks linked lab and belonging of the original visit before inserting',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FROM sdc."WORKS_WITH"'))return {rowCount:1,rows:[{one:1}]};
  if(sql.includes('FROM sdc."VISIT"'))return {rowCount:0,rows:[]};
 });
 const r=await svc.createLabCase(pool,'8','100','4',{visit_id:'9',work_type:'تاج زركون',delivery_date:'2099-01-02',notes:''});
 assert.equal(r.status,'not_found');
 const visit=calls.find(x=>x.sql.includes('FROM sdc."VISIT"'));
 assert(visit.sql.includes('b."Clinic_ID"=$1::bigint'));
 assert.deepEqual(visit.args,['8','9']);
 assert(!calls.some(x=>x.sql.includes('INSERT INTO sdc."LAB_ORDER"')));
});
test('valid lab creation inserts order and item in the same transaction, never client-side only',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FROM sdc."WORKS_WITH"'))return {rowCount:1,rows:[{one:1}]};
  if(sql.includes('FROM sdc."VISIT"'))return {rowCount:1,rows:[{Visit_ID:'9'}]};
  if(sql.includes('INSERT INTO sdc."LAB_ORDER"'))return {rowCount:1,rows:[{Lab_Order_ID:'200'}]};
 });
 const r=await svc.createLabCase(pool,'8','100','4',{visit_id:'9',work_type:'تاج زركون',delivery_date:'2099-01-02',tooth:'11',shade:'A2'});
 assert.deepEqual(r,{status:'ok',id:'200'});
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."LAB_ORDER_ITEMS"')&&x.args.at(-1)==='200'));
 assert(calls.some(x=>x.sql==='COMMIT'));
});
test('job save is scoped to authenticated clinic and updates by clinic plus job ID',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FROM sdc."SPECIALTY"'))return {rowCount:1,rows:[{Specialty_ID:17}]};
  if(sql.includes('UPDATE sdc."JOB"'))return {rowCount:1,rows:[{Job_ID:3}]};
 });
 const r=await svc.saveJob(pool,'8','100',{...job,job_id:'3'});
 assert.equal(r.status,'ok');
 const update=calls.find(x=>x.sql.includes('UPDATE sdc."JOB"'));
 assert(update.sql.includes('WHERE "Clinic_ID"=$1::bigint AND "Job_ID"=$2::bigint'));
 assert.deepEqual(update.args.slice(0,2),['8','3']);
 assert(calls.some(x=>x.sql==='COMMIT'));
});
test('updating applicant status is clinic-scoped, pending is canonical schema value',async()=>{
 const {pool,calls}=fake(sql=>sql.includes('UPDATE sdc."APPLIES_FOR"')?{rowCount:1,rows:[{Application_ID:'90'}]}:null);
 assert.equal((await svc.changeApplication(pool,'8','100','90',{status:'pending'})).status,'ok');
 const update=calls.find(x=>x.sql.includes('UPDATE sdc."APPLIES_FOR"'));
 assert(update.sql.includes('j."Clinic_ID"=$1::bigint'));
 assert.equal(update.args[2],'pending');
 assert(!update.sql.includes('"Application_Status"=\'review\''));
});
test('report date ranges strictly validate custom input and reject overlong windows',()=>{
 assert.equal(reports.period({clinic_report_period:'custom',clinic_report_from:'2026-02-30',clinic_report_to:'2026-05-01'}),null);
 assert.equal(reports.period({clinic_report_period:'custom',clinic_report_from:'2024-01-01',clinic_report_to:'2026-01-01'}),null);
 assert.equal(reports.period({clinic_report_period:'custom',clinic_report_from:'2026-08-01',clinic_report_to:'2026-07-01'}),null);
 assert.equal(reports.period({clinic_report_period:'strange'}),null);
 const valid=reports.period({clinic_report_period:'custom',clinic_report_from:'2026-10-01',clinic_report_to:'2026-10-07'});
 assert.deepEqual([valid.from,valid.to,valid.displayTo],['2026-10-01','2026-10-08','2026-10-07']);
});
test('new modules preserve original UI and require server-side CSRF and clinic authorization',()=>{
 const read=f=>fs.readFileSync(path.join(root,f),'utf8');
 const router=read('src/clinic-remaining-router.js');
 const docRouter=read('src/clinic-documents-router.js');
 const notify=read('src/clinic-notifications-router.js');
 assert(router.includes('validateSessionCsrf')&&router.includes('clinicId(req)'));
 assert(docRouter.includes('validateSessionCsrf')&&docRouter.includes('clinicId(req)'));
 assert(notify.includes('"User_ID"=$1::bigint')&&notify.includes('validateSessionCsrf'));
 assert(read('server.js').includes('clinic-remaining-router'));
 for(const page of ['lab-cases','lab-details','jobs','job-applicants','application-details','reports']){
  const html=read(`views/clinic/${page}.ejs`);
  assert(html.includes("partials/clinic/header")&&html.includes("partials/clinic/footer"));
 }
});

test('v24.1: job listing uses actual SPECIALTY columns from committed PostgreSQL schema',async()=>{
 const schema=fs.readFileSync(path.join(root,'db/schema/001_Smart_Dental_Clinic_Original.sql'),'utf8');
 const specialty=schema.match(/CREATE TABLE "SPECIALTY" \(([\s\S]*?)\n\);/);
 assert(specialty, 'SPECIALTY table missing from schema');
 assert(specialty[1].includes('"Name_AR"'));
 assert(!specialty[1].includes('"Specialty_Name"'));
 const sql=[];
 const result=await svc.jobs({async query(query,args){
  sql.push(query);
  assert(!query.includes('s."Specialty_Name"'));
  if(query.includes('FROM sdc."JOB"'))return {rows:[{Job_ID:5,Specialty_Name:'طب عام',applicant_count:0,Job_Title:'طبيب أسنان'}]};
  return {rows:[{Specialty_ID:7,Specialty_Name:'طب الأسنان'}]};
 }},'22');
 assert.equal(result.jobs.length,1);
 assert.equal(result.specialties[0].Specialty_Name,'طب الأسنان');
 assert(sql[0].includes('s."Name_AR" AS "Specialty_Name"'));
 assert(sql[1].includes('"Name_AR" AS "Specialty_Name"'));
 assert(sql[1].includes('"Is_Active"=TRUE'));
});

test('v24.1: all clinic notification menus share viewport bounds and readable content',()=>{
 const header=fs.readFileSync(path.join(root,'views/partials/clinic/header.ejs'),'utf8');
 const menus=[...header.matchAll(/class="[^"]*notification-menu[^"]*"/g)];
 assert.equal(menus.length,3, 'There must be three existing clinic navbar variants');
 assert(menus.every(m=>m[0].includes('notification-menu-safe')));
 const css=fs.readFileSync(path.join(root,'public/clinic/assets/styles.css'),'utf8');
 assert(css.includes('@media (max-width: 767.98px)'));
 assert(css.includes('.clinic-navbar .notification-dropdown > .notification-menu'));
 assert(css.includes('width: calc(100vw - 24px) !important'));
 assert(css.includes('max-height: calc(100dvh - 84px)'));
 assert(css.includes('overflow-wrap: anywhere'));
});
