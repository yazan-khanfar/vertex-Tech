'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const svc=require('../src/clinic-staff/service');const specialties=require('../src/clinic-staff/specialties');
const base=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(base,p),'utf8');
const good={action:'create',account_mode:'create',staff_form_name:'أحمد محمود',staff_form_email:'employee@example.com',staff_form_phone:'0599222333',password:'securePassword2026!',password_confirmation:'securePassword2026!',clinic_role_id:'reception',staff_form_status:'active','permissions[]':['appointments.view','patients.view_admin']};
test('validates staff role, scope, email, strong password, and permission allowlist',()=>{
 assert.equal(svc.validate(good).email,'employee@example.com');
 assert.equal(svc.validate({...good,'permissions[]':['visits.diagnosis.write']}),null);
 assert.equal(svc.validate({...good,'permissions[]':['appointments.view','appointments.view']}),null);
 assert.equal(svc.validate({...good,clinic_role_id:'admin'}),null);
 assert.equal(svc.validate({...good,account_mode:'existing'}),null);
 assert.equal(svc.validate({...good,password_confirmation:'no'}),null);
 assert.equal(svc.validate({...good,password:'short',password_confirmation:'short'}),null);
 assert.equal(svc.validate({clinic_role_id:'accountant',staff_form_status:'suspended','permissions[]':[]},true).permissions.length,0);
});
function fakeDb(testCase){const calls=[];const client={release(){},async query(sql,params=[]){calls.push({sql,params});
 if(sql.includes('SELECT 1 FROM sdc."CLINIC" c JOIN'))return {rowCount:testCase?.forbid?0:1,rows:[{a:1}]};
 if(sql.includes('FROM sdc."USER" WHERE lower'))return {rowCount:testCase?.dup?1:0,rows:[]};
 if(sql.includes('FROM sdc."ROLE" WHERE'))return {rowCount:1,rows:[{Role_ID:5}]};
 if(sql.includes('RETURNING "User_ID"'))return {rowCount:1,rows:[{User_ID:101}]};
 if(sql.includes('SELECT s."Membership_Status" AS status'))return {rowCount:1,rows:[{status:testCase?.status||'active'}]};
 return {rowCount:1,rows:[]};
 }};return {pool:{connect:async()=>client},calls};}
test('creating staff account and permissions is transactionally tied to managed clinic',async()=>{
 const {pool,calls}=fakeDb();const out=await svc.save(pool,10,20,good);
 assert.equal(out.status,'ok');assert(calls.some(c=>c.sql.includes('INSERT INTO sdc."USER"')));
 assert(calls.some(c=>c.sql.includes('INSERT INTO sdc."STAFF_AT"')&&c.params.includes(10)));
 assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO sdc."STAFF_PERMISSIONS"')).length,2);
 assert(calls.some(c=>c.sql==='COMMIT'));
});
test('a manager from a different clinic cannot create staff membership',async()=>{
 const {pool,calls}=fakeDb({forbid:true});assert.equal((await svc.save(pool,10,20,good)).status,'forbidden');
 assert(!calls.some(c=>c.sql.includes('INSERT INTO sdc."USER"')));
 assert(calls.some(c=>c.sql==='ROLLBACK'));
});
test('existing email is rejected without creating a duplicate user or membership',async()=>{
 const {pool,calls}=fakeDb({dup:true});assert.equal((await svc.save(pool,10,20,good)).status,'duplicate');
 assert(!calls.some(c=>c.sql.includes('INSERT INTO sdc."STAFF_AT"')));
});
test('permissions are replaced only inside current clinic, revoke existing sessions',async()=>{
 const {pool,calls}=fakeDb();const out=await svc.save(pool,10,20,{action:'update',staff_id:'101',clinic_role_id:'coordinator',staff_form_status:'active','permissions[]':['appointments.view']});
 assert.equal(out.status,'ok');
 const del=calls.find(c=>c.sql.includes('DELETE FROM sdc."STAFF_PERMISSIONS"'));
 assert.deepEqual(del.params,['101',10]);
 assert(calls.some(c=>c.sql.includes('UPDATE sdc."USER_SESSIONS"')));
 assert(calls.some(c=>c.sql.includes('INSERT INTO sdc."STAFF_PERMISSIONS"')&&c.params[0]==='appointments.view'));
});
test('archived staff are rejected on repeated archive',async()=>{
 const {pool,calls}=fakeDb({status:'inactive'});assert.equal((await svc.save(pool,10,20,{action:'archive',staff_id:'101'})).status,'stale');
 assert(!calls.some(c=>c.sql.includes('UPDATE sdc."STAFF_AT"')));
});
test('specialties derived only from active clinic doctor memberships',async()=>{
 const queries=[];const pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:[]}}};
 assert.deepEqual(await specialties.list(pool,17),[]);assert.deepEqual(queries[0].args,[17]);
 assert(queries[0].sql.includes('"Membership_Status"=\'active\''));
 assert(queries[0].sql.includes('"Clinic_ID"=$1::bigint'));
});
test('keeps original templates and does not touch the stylesheet',()=>{
 const page=read('views/clinic/staff.ejs'),spec=read('views/clinic/specialties.ejs'),server=read('server.js');
 assert(page.includes('id="staffModal"')&&page.includes('id="staffViewModal"'));
 assert(page.includes('id="staffTableBody"')&&page.includes('class="stat-card"'));
 assert(page.includes('action="/clinic/staff"')&&!page.includes('U-STAFF-001'));
 assert(spec.includes('class="catalog-item"')&&spec.includes('specialties'));
 assert(server.includes("app.use('/clinic',require('./src/clinic-staff/router'))"));
});
