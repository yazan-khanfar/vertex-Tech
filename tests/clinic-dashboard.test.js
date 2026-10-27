'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const svc=require('../src/clinic-dashboard/service');
const now={date:'2026-10-26',time:'11:30'}; // Monday in clinic-local time
function fake(overrides={}){
 const standard={
  clinic:[{id:'23',name:'عيادة أمانة'}],
  weekly:[{start:'09:00',end:'17:00'}],exceptions:[],
  counts:[{total:3,confirmed:1,waiting:1,completed:1}],
  appointments:[{id:'101',time:'10:00',status:'confirmed',patient:'مريض اختبار',doctor:'د. اختبار',service:'تنظيف'}],
  pending:[{id:'102',total_pending:7,date:'2026-10-27',time:'10:30',patient:'مريض جديد',doctor:'د. اختبار'}],
  reschedules:[{id:'103',date:'2026-10-28',time:'11:30',patient:'مريض تعديل'}],
  doctors:[{id:'7',name:'د. اختبار',specialties:'طب عام',start:'10:00',end:'15:00'}],
  'invoice-count':[{count:2}],invoices:[{id:'900',amount:'75.00'}]
 };
 const data={...standard,...overrides};const queries=[];
 const pool={queries,async query(sql,args){
   const match=/\/\* dashboard:([\w-]+) \*\//.exec(sql);
   assert(match,'Every dashboard SQL call must have a marker');
   assert.equal(args[0],'23','Every dashboard query must include active clinic as first parameter');
   queries.push({kind:match[1],sql,args});
   return {rows:data[match[1]]||[],rowCount:(data[match[1]]||[]).length};
 }};
 return pool;
}
test('clinic dashboard draws live counts, appointments, alerts, doctors and open status without mock records',async()=>{
 const db=fake();const d=await svc.load(db,'23',now);
 assert.equal(d.clinic.name,'عيادة أمانة');assert.equal(d.stats.today,3);
 assert.equal(d.stats.pendingApprovals,7,'Count is not capped by pending preview limit');
 assert.equal(d.stats.unpaidInvoices,2);assert.equal(d.stats.doctorCount,1);assert.equal(d.open,true);
 assert.equal(d.appointments[0].patient,'مريض اختبار');assert.equal(d.appointments[0].statusLabel,'مؤكد');
 assert.equal(d.alerts.length,3);assert.equal(d.alerts[0].url,'/clinic/appointment-details?id=102');
 assert.equal(d.alerts[2].title,'فاتورة غير مكتملة');
 assert(db.queries.every(q=>q.args[0]==='23'));
 assert(db.queries.find(q=>q.kind==='counts').args.includes('2026-10-26'));
 assert(db.queries.find(q=>q.kind==='invoice-count').sql.includes('sdc.invoice_balances'));
});
test('closed clinic exception hides all availability and sets closed status',async()=>{
 const db=fake({exceptions:[{type:'closed'}]});const d=await svc.load(db,'23',now);
 assert.equal(d.open,false);assert.equal(d.doctors.length,0);assert.equal(d.stats.doctorCount,0);
 assert.equal(d.clinicHoursLabel,'لا توجد ساعات عمل اليوم');
});
test('custom hours replace regular hours and doctor must overlap',async()=>{
 const db=fake({exceptions:[{type:'custom_hours',start:'14:00',end:'17:00'}],doctors:[
  {id:'7',name:'د. اختبار',start:'09:00',end:'12:00'},
  {id:'8',name:'د. دوام مسائي',start:'15:00',end:'17:00'}
 ]});const d=await svc.load(db,'23',now);
 assert.equal(d.open,false);assert.equal(d.stats.doctorCount,1);assert.equal(d.doctors[0].name,'د. دوام مسائي');
});
test('empty database results render no phantom patients, invoices or doctors',async()=>{
 const db=fake({counts:[],appointments:[],pending:[],reschedules:[],doctors:[],invoices:[], 'invoice-count':[]});
 const d=await svc.load(db,'23',now);
 assert.equal(d.stats.today,0);assert.equal(d.stats.pendingApprovals,0);assert.equal(d.stats.unpaidInvoices,0);
 assert.deepEqual(d.appointments,[]);assert.deepEqual(d.alerts,[]);assert.deepEqual(d.doctors,[]);
});
test('wrong or nonexistent clinic ID is refused',async()=>{
 assert.equal(await svc.load(fake(),'oops',now),null);
 assert.equal(await svc.load(fake({clinic:[]}), '23',now),null);
});
test('doctor rows deduplicate multiple shifts; absences filtered by SQL',async()=>{
 const db=fake({doctors:[{id:'7',name:'د. اختبار',start:'09:00',end:'12:00'},
 {id:'7',name:'د. اختبار',start:'13:00',end:'17:00'}]});
 const d=await svc.load(db,'23',now);assert.equal(d.stats.doctorCount,1);
 assert(d.doctors[0].untilLabel.includes('5:00'));
 const sql=db.queries.find(q=>q.kind==='doctors').sql;
 assert(sql.includes('DOCTOR_ABSENCES')&&sql.includes('Start_Date')&&sql.includes('License_Status'));
});
test('clinic dashboard keeps the original page and redirects no navigation into a duplicate UI',()=>{
 const root=path.resolve(__dirname,'..');const html=fs.readFileSync(path.join(root,'views/clinic/index.ejs'),'utf8');
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert(html.includes('dashboard-hero')&&html.includes('stat-card')&&html.includes('status-strip'));
 assert(html.includes("include('../partials/clinic/header')"));
 assert(html.includes("include('../partials/clinic/footer')"));
 assert(!html.includes('أحمد خالد')&&!html.includes('عيادة الابتسامة الحديثة')&&!html.includes('IN-118'));
 assert(html.includes('dashboard.appointments')&&html.includes('dashboard.doctors'));
 assert(server.includes("app.use('/clinic',require('./src/clinic-dashboard/router'))"));
 assert(!fs.existsSync(path.join(root,'views/clinic/dashboard.ejs')));
});
