'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const directory=require('../src/patient-directory-service');
const root=path.resolve(__dirname,'..');
const pages=['clinic/appointment-details','clinic/appointments','clinic/doctor-details','clinic/doctors','clinic/new-appointment','doctor/appointments','doctor/schedule','patient/appointments','patient/book-appointment','patient/booking-details','staff/appointments'];
function render(file,locals,depth=0){
 assert(depth<14);
 const source=fs.readFileSync(file,'utf8');const rx=/<%([=-]?)([\s\S]*?)%>/g;
 let m,i=0,prog='let html="";\n';
 const literal=s=>{if(s)prog+='html += '+JSON.stringify(s)+';\n';};
 while((m=rx.exec(source))){literal(source.slice(i,m.index));prog+=m[1]?'html += ('+m[2]+');\n':m[2]+'\n';i=m.index+m[0].length;}
 literal(source.slice(i));prog+='return html;';
 const include=(relative,extra={})=>render(path.resolve(path.dirname(file),relative+'.ejs'),{...locals,...extra},depth+1);
 return new Function('locals','include','with(locals){'+prog+'}')(locals,include);
}
const sample={
 currentPage:'patient/clinics.html',role:'patient',navVariant:'patient',drawerVariant:'patient',footerVariant:'patient',
 navActiveClass:()=>'',navAriaCurrent:()=>'',drawerActiveClass:()=>'',drawerAriaCurrent:()=>'',
 currentUser:{fullName:'مستخدم حقيقي'},activeClinic:null,logoutCsrf:'fake',staffPermissions:'',
 csrfToken:'CSRF',followUpVisitId:'',now:{date:'2026-10-28',time:'10:00'},message:'',error:'',labels:{pending:'بانتظار الموافقة',confirmed:'مؤكد'},
 clinics:[{id:'812',name:'عيادة اختبار SQL',city:'نابلس',area:'المدينة',latitude:'32.22',longitude:'35.24',service_count:2,service_ids:'22,23',doctor_count:1,online_booking:true}],
 clinicServices:[{id:'22',name:'تنظيف'}],
 doctorMembershipMessage:'',eligibleDoctors:[],otherMemberships:[],doctors:[{id:'91',name:'اسم الطبيب',specialties:'طب عام',clinic_id:'812',clinic_name:'عيادة اختبار SQL',bookable:true,experience:5,bio:'وصف حقيقي'}],
 clinic:{id:'812',name:'عيادة اختبار SQL',city:'نابلس',area:'المدينة',description:'بيانات تجريبية للاختبار فقط'},
 doctor:{id:'91',name:'اسم الطبيب',specialties:'طب عام',clinic_id:'812',clinic_name:'عيادة اختبار SQL',bookable:true,experience:5,bio:'نبذة'},
 services:[{id:'22',name:'تنظيف',price:'160',duration:30}],hours:[{day:6,start:'09:00',finish:'12:00'}],
 rows:[{clinic_id:'812',clinic_name:'عيادة اختبار SQL',doctor_id:'91',doctor_name:'اسم الطبيب',service_id:'22',service_name:'تنظيف',price:'160',duration:30}],
 selection:{clinic_id:'812',doctor_id:'91',service_id:'22',appointment_date:'2026-10-29'},
 selected:{clinic_id:'812',clinic_name:'عيادة اختبار SQL',doctor_id:'91',doctor_name:'اسم الطبيب',service_id:'22',service_name:'تنظيف',price:'160',duration:30},timeSlots:['09:00'],availabilityMessage:'',patients:[{id:'18',name:'اسم المريض'}],selectedPatientId:'',
 bookings:[{id:'44',patient_name:'اسم المريض',doctor_name:'اسم الطبيب',service_name:'تنظيف',clinic_name:'عيادة اختبار SQL',status:'pending',date:'2026-10-29',time:'09:00',price:'160',duration:30,request_status:null}],
 booking:{id:'44',patient_id:'18',patient_name:'اسم المريض',doctor_name:'اسم الطبيب',service_name:'تنظيف',clinic_name:'عيادة اختبار SQL',status:'pending',date:'2026-10-29',time:'09:00',price:'160',duration:30,request_status:null,source:'manual',notes:null},
 profile:{person:{id:'91',name:'اسم الطبيب',specialties:'طب عام',start_date:'2026-10-01'},periods:[{day:6,start:'09:00',end:'13:00',active:true}],absences:[],services:[]},
 WEEKDAYS:['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت']
};
test('patient directory validates numeric IDs and does not query unknown or fake slugs',async()=>{
 assert.equal(directory.numericId('812'),'812');assert.equal(directory.numericId('smile'),null);
 let called=false;
 assert.equal(await directory.clinicDetails({query(){called=true;}},'smile'),null);
 assert.equal(called,false);
});
test('clinic discovery only queries active approved clinics; doctor SQL enforces verified active memberships',async()=>{
 const queries=[];const db={async query(sql,params){queries.push({sql,params});return {rows:[{id:'812'}]};}};
 assert.equal((await directory.clinics(db)).length,1);
 assert.equal((await directory.doctors(db))[0].id,'812');
 assert.match(queries[0].sql,/"Approval_Status"='approved'/);
 assert.match(queries[1].sql,/"Membership_Status"='active'/);
 assert.match(queries[1].sql,/"License_Status"='verified'/);
 assert.deepEqual(queries[1].params,[null]);
});
test('patient clinic/doctor directory renders database fixtures into original card shells',()=>{
 for(const p of ['patient/clinics','patient/doctors','patient/clinic-details','patient/doctor-details']){
  const html=render(path.join(root,'views',p+'.ejs'),sample);
  assert.match(html,/عيادة اختبار SQL/);
  assert.match(html,/\/patient\/(?:clinic-details|doctor-details|book-appointment)\?/);
  assert.match(html,/(?:doctor-catalog-card|clinic-filter-item|soft-card|doctor-hero)/);
  assert.doesNotMatch(html,/عيادة الابتسامة الحديثة|د\. عمر ناصر/);
 }
});
test('restored 11 appointment pages retain the original UI markers and dynamic records',()=>{
 for(const page of pages){
  const file=path.join(root,'views',page+'.ejs');
  const text=fs.readFileSync(file,'utf8');
  for(const marker of ['<main','<%- include(\'../partials/'])assert(text.includes(marker),page+' layout '+marker);
  assert(text.includes('assets/styles.css'),page+' original stylesheet');
  assert(text.length>3300,page+' unexpectedly shortened');
  const html=render(file,sample);
  assert(html.includes('</html>'),page+' render');
  if(page==='patient/appointments')assert.match(html,/اسم الطبيب/);
  if(page==='clinic/appointments'||page==='doctor/appointments')assert.match(html,/اسم المريض/);
 }
});

test('checkout keeps original two-card design and has no duplicate booking fields or actions',()=>{
 const file=path.join(root,'views/patient/book-appointment.ejs');
 const html=render(file,sample);
 const occurrence=s=>(html.match(new RegExp(s,'g'))||[]).length;
 assert.equal(occurrence('id="bookingCatalogForm"'),1,'catalog form duplicated');
 assert.equal(occurrence('id="bookingClinicSelect"'),1,'clinic selection duplicated');
 assert.equal(occurrence('id="bookingDoctorSelect"'),1,'doctor selection duplicated');
 assert.equal(occurrence('id="bookingDate"'),1,'date duplicated');
 assert.equal(occurrence('id="serviceSelect"'),1,'service duplicated');
 assert.equal(occurrence('>عرض الأوقات المتاحة</button>'),1,'availability action duplicated');
 assert.equal(occurrence('class="soft-card p-4 mb-4"'),1,'original selected-clinic card missing');
 assert.equal(occurrence('class="soft-card p-4 p-lg-5"'),1,'original time-slot card missing');
 assert.match(html,/class="slot-grid"/);
 assert.match(html,/name="appointment_time" value="09:00" form="backend-form-1"/);
 assert.match(html,/name="csrf_token" value="CSRF"/);
 assert.match(html,/form="bookingCatalogForm" required>/);
 assert.doesNotMatch(html,/name="appointment_date"[^>]*name="appointment_date"/);
 assert.match(html,/عيادة اختبار SQL/);
 assert.match(html,/اسم الطبيب/);
 const empty=render(file,{...sample,rows:[],selected:null,timeSlots:[],selection:{clinic_id:'',doctor_id:'',service_id:'',appointment_date:''}});
 assert.match(empty,/لا توجد عيادات وأطباء/);
 assert.match(empty,/id="confirmBooking"[^>]*disabled/);
});

test('appointment list renders state-dependent stripe colors once and no duplicated banners',()=>{
 const html=render(path.join(root,'views/patient/appointments.ejs'),{...sample,bookings:[{...sample.bookings[0],status:'confirmed'}],message:'تم الحفظ'});
 assert.match(html,/appointment-status-line bg-success/);
 assert.equal((html.match(/تم الحفظ/g)||[]).length,1);
});
