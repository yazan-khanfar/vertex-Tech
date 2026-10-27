'use strict';
const express=require('express');
const pages=require('../../config/page-map.json');
const {getPool}=require('../../db/pool');
const {sessionCsrf,validateSessionCsrf}=require('../auth/session');
const svc=require('./service');const schedules=require('./schedule');const memberships=require('../clinic-doctors/service');
const routers={patient:express.Router(),doctor:express.Router(),clinic:express.Router(),staff:express.Router()};
// Parse only appointment forms, not every POST in a role. Other modules own their own limits.
const appointmentForm=express.urlencoded({extended:false,limit:'16kb',parameterLimit:40});
routers.patient.use(['/book-appointment','/appointments/action'],appointmentForm);
routers.doctor.use('/appointments/action',appointmentForm);
routers.clinic.use(['/new-appointment','/appointments/action','/doctors/invite','/doctors/membership','/doctor-details'],appointmentForm);
function data(req,res,view,stuff={}){
 const item=pages[`${view}.html`];if(!item)throw new Error('Missing route metadata '+view);
 const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
 const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
 return {currentPage:`${view}.html`,role:item.role,navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
  navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
  staffPermissions:res.locals.staffPermissions||'',staffClinicRole:res.locals.staffClinicRole||'',hasStaffPermission:code=>require('../staff-access/policy').can(res.locals.staffPermissions,code),currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',csrfToken:sessionCsrf(req),labels:svc.labels,now:svc.localNow(),error:'',message:'',...stuff};
}
function manager(req){const id=String(req.sdcSession?.clinicId||'');return svc.num(id)&&req.sdcClinics.some(c=>c.id===id&&c.manager)?id:null;}
function doctorClinic(req){const id=String(req.sdcSession?.clinicId||'');return svc.num(id)&&req.sdcClinics.some(c=>c.id===id)?id:null;}
function actor(req,isManager=false){return {...req.sdcActor,isManager};}
const fail=(res,error)=>res.status(503).send('تعذّر إجراء العملية. راجع سجل التشغيل ولا تحاول تكرار الحجز دون التحقق من مواعيدك.');
function wrap(fn){return (req,res,next)=>Promise.resolve(fn(req,res)).catch(e=>{console.error('[APPOINTMENTS_FAILED]',e.code||'UNKNOWN',e.constraint||'');if(e.code==='23514'||e.code==='23505'||e.code==='23503')return res.status(409).send('لا يمكن تنفيذ العملية بسبب تعارض موعد أو قيد في قاعدة البيانات. حدّث الصفحة وأعد المحاولة.');return fail(res,e);});}
function msg(req){return req.query.saved==='1'?'تم حفظ العملية في قاعدة البيانات بنجاح.':req.query.error==='unavailable'?'الوقت لم يعد متاحًا، أو جدول الطبيب غير مكتمل. اختر وقتًا آخر.':'';}
async function followUpContext(pool,clinicId,visitId){
 if(!svc.num(visitId)||!svc.num(clinicId))return null;
 const {rows}=await pool.query(`SELECT b."Patient_ID"::text AS patient_id,b."Doctor_ID"::text AS doctor_id,b."Service_ID"::text AS service_id,
 to_char(v."Suggested_Date",'YYYY-MM-DD') AS date FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID"
 WHERE v."Visit_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND b."Booking_Status"='completed'
 AND v."Follow_Up_Type" IS NOT NULL AND v."Suggested_Date" IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM sdc."BOOKING" x WHERE x."Follow_Up_Of_Visit_ID"=v."Visit_ID")`,[visitId,clinicId]);
 return rows[0]||null;
}
async function getBooking(req,res,kind){
 const id=kind==='clinic'?manager(req):null;
 if(kind==='clinic'&&!id)return res.sendStatus(403);
 const followUp=kind==='clinic'&&req.query.follow_up_visit_id?await followUpContext(getPool(),id,req.query.follow_up_visit_id):null;
 if(kind==='clinic'&&req.query.follow_up_visit_id&&!followUp)return res.sendStatus(404);
 const rows=await svc.catalog(getPool(),id);
 const q={clinic_id:kind==='clinic'?id:String(req.query.clinic_id||''),doctor_id:String(req.query.doctor_id||followUp?.doctor_id||''),service_id:String(req.query.service_id||followUp?.service_id||''),appointment_date:String(req.query.appointment_date|| (followUp?.date>=svc.localNow().date?followUp?.date:'') ||'')};
 const selected=svc.chosen(rows,q);
 const patient=kind==='patient'?await svc.patientId(getPool(),req.sdcActor.userId):null;
 const availability=selected&&q.appointment_date?await svc.availability(getPool(),selected,q.appointment_date,kind==='patient'?patient:null):null;
 const timeSlots=availability?.slots||[];
 const availabilityMessage=availability&&!timeSlots.length?svc.availabilityReasons[availability.reason]||'لا توجد أوقات متاحة في هذا التاريخ.':'';
 const patients=kind==='clinic'?await svc.patientOptions(getPool(),id):[];
 res.set('Cache-Control','no-store');return res.render(kind==='patient'?'patient/book-appointment':'clinic/new-appointment',data(req,res,kind==='patient'?'patient/book-appointment':'clinic/new-appointment',{rows,selection:q,selected,timeSlots,availabilityMessage,patients,selectedPatientId:kind==='clinic'&&patients.some(p=>p.id===String(req.query.patient||followUp?.patient_id||''))?String(req.query.patient||followUp?.patient_id):'',followUpVisitId:followUp?String(req.query.follow_up_visit_id):'',message:msg(req)}));
}
async function postBooking(req,res,kind){
 const id=kind==='clinic'?manager(req):null;
 if(kind==='clinic'&&!id)return res.sendStatus(403);
 if(!validateSessionCsrf(req))return res.status(403).send('رمز حماية النموذج غير صالح، حدّث الصفحة.');
 const body={...req.body,clinic_id:kind==='clinic'?id:req.body.clinic_id};
 const result=await svc.book(getPool(),body,actor(req,true),id);
 if(result.status==='ok')return res.redirect(303,kind==='patient'?`/patient/booking-details?id=${encodeURIComponent(result.id)}`:`/clinic/appointment-details?id=${encodeURIComponent(result.id)}`);
 if(result.status==='forbidden')return res.sendStatus(403);
 return res.redirect(303,`${kind==='patient'?'/patient/book-appointment':'/clinic/new-appointment'}?error=unavailable`);
}
// Real patient directory, rendered into the existing visual catalog pages.
const directory=require('../patient-directory-service');
routers.patient.get('/clinics',wrap(async(req,res)=>{
 const [clinics,clinicServices]=await Promise.all([directory.clinics(getPool()),directory.services(getPool())]);res.set('Cache-Control','no-store');
 return res.render('patient/clinics',data(req,res,'patient/clinics',{clinics,clinicServices}));
}));
routers.patient.get('/doctors',wrap(async(req,res)=>{
 const doctors=await directory.doctors(getPool());res.set('Cache-Control','no-store');
 return res.render('patient/doctors',data(req,res,'patient/doctors',{doctors}));
}));
routers.patient.get('/clinic-details',wrap(async(req,res)=>{
 const profile=await directory.clinicDetails(getPool(),req.query.clinic_id);
 if(!profile)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('patient/clinic-details',data(req,res,'patient/clinic-details',{...profile}));
}));
routers.patient.get('/doctor-details',wrap(async(req,res)=>{
 const profile=await directory.doctorDetails(getPool(),req.query.doctor_id,req.query.clinic_id||null);
 if(!profile)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('patient/doctor-details',data(req,res,'patient/doctor-details',{...profile}));
}));
routers.patient.get('/book-appointment',wrap((req,res)=>getBooking(req,res,'patient')));
routers.patient.post('/book-appointment',wrap((req,res)=>postBooking(req,res,'patient')));
routers.clinic.get('/new-appointment',wrap((req,res)=>getBooking(req,res,'clinic')));
routers.clinic.post('/new-appointment',wrap((req,res)=>postBooking(req,res,'clinic')));
routers.patient.get('/appointments',wrap(async(req,res)=>{
 const bookings=await svc.list(getPool(),actor(req),null);
 res.set('Cache-Control','no-store');return res.render('patient/appointments',data(req,res,'patient/appointments',{bookings,message:msg(req)}));
}));
routers.doctor.get('/appointments',wrap(async(req,res)=>{
 const id=doctorClinic(req);if(!id)return res.sendStatus(403);
 const bookings=await svc.list(getPool(),actor(req),id);
 res.set('Cache-Control','no-store');return res.render('doctor/appointments',data(req,res,'doctor/appointments',{bookings,message:msg(req)}));
}));
routers.staff.get('/appointments',wrap(async(req,res)=>{
 const clinicId=String(req.sdcSession?.clinicId||'');
 if(!svc.num(clinicId)||!req.sdcClinics.some(c=>c.id===clinicId))return res.sendStatus(403);
 const bookings=await svc.clinicList(getPool(),clinicId);
 res.set('Cache-Control','no-store');return res.render('staff/appointments',data(req,res,'staff/appointments',{bookings}));
}));
routers.clinic.get('/appointments',wrap(async(req,res)=>{
 const id=manager(req);if(!id)return res.sendStatus(403);
 const bookings=await svc.clinicList(getPool(),id);
 res.set('Cache-Control','no-store');return res.render('clinic/appointments',data(req,res,'clinic/appointments',{bookings,message:msg(req)}));
}));
async function getDetail(req,res,kind){
 const clinicId=kind==='clinic'?manager(req):null;
 if(kind==='clinic'&&!clinicId)return res.sendStatus(403);
 const booking=await svc.detail(getPool(),req.query.id,actor(req,kind==='clinic'),clinicId);
 if(!booking)return res.sendStatus(404);
 const path=kind==='clinic'?'clinic/appointment-details':'patient/booking-details';
 res.set('Cache-Control','no-store');return res.render(path,data(req,res,path,{booking,message:msg(req)}));
}
routers.clinic.get('/appointment-details',wrap((req,res)=>getDetail(req,res,'clinic')));
routers.patient.get('/booking-details',wrap((req,res)=>getDetail(req,res,'patient')));
async function handleAction(req,res,kind){
 if(!validateSessionCsrf(req))return res.status(403).send('رمز حماية غير صالح.');
 const clinicId=kind==='patient'?null:doctorClinic(req);
 if(kind!=='patient'&&!clinicId)return res.sendStatus(403);
 if(kind==='clinic'&&!manager(req))return res.sendStatus(403);
 const result=await svc.action(getPool(),actor(req,kind==='clinic'),clinicId,req.body);
 if(result.status==='forbidden')return res.sendStatus(403);
 if(result.status==='not_found')return res.sendStatus(404);
 if(result.status==='reason_required')return res.status(422).send('يرجى إدخال سبب رفض الموعد (حتى 2000 حرف) قبل التأكيد.');
 if(result.status!=='ok')return res.status(409).send(result.status==='unavailable'?'الموعد المطلوب غير متاح، حدّث الصفحة واختر وقتًا آخر.':'لا يمكن تعديل هذا الحجز في حالته الحالية.');
 const dest=kind==='patient'?`/patient/booking-details?id=${result.id}&saved=1`:kind==='clinic'?`/clinic/appointment-details?id=${result.id}&saved=1`:'/doctor/appointments?saved=1';
 return res.redirect(303,dest);
}
for(const kind of ['patient','doctor','clinic'])routers[kind].post('/appointments/action',wrap((req,res)=>handleAction(req,res,kind)));
routers.clinic.get('/doctors',wrap(async(req,res)=>{
 const id=manager(req);if(!id)return res.sendStatus(403);
 const [doctors,eligibleDoctors,otherMemberships]=await Promise.all([schedules.doctors(getPool(),id),memberships.candidates(getPool(),id),memberships.others(getPool(),id)]);
 res.set('Cache-Control','no-store');return res.render('clinic/doctors',data(req,res,'clinic/doctors',{doctors,eligibleDoctors,otherMemberships,doctorMembershipMessage:String(req.query.membership||'')}));
}));
routers.clinic.post('/doctors/invite',wrap(async(req,res)=>{
 const id=manager(req);if(!id)return res.sendStatus(403);
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 const result=await memberships.invitation(getPool(),id,req.sdcActor.doctorId,req.sdcActor.userId,req.body);
 const statuses={invalid:422,unavailable:409,already:409,forbidden:403};
 if(result.status==='ok')return res.redirect(303,'/clinic/doctors?membership=invited');
 if(result.status==='forbidden')return res.sendStatus(403);
 return res.status(statuses[result.status]||409).send(result.status==='invalid'?'يرجى اختيار طبيب معتمد وتاريخ بدء عمل صحيح.':result.status==='already'?'هذا الطبيب لديه دعوة أو عضوية قائمة.':'الطبيب غير متاح للانضمام حاليًا.');
}));
routers.clinic.post('/doctors/membership',wrap(async(req,res)=>{
 const id=manager(req);if(!id)return res.sendStatus(403);
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 const r=await memberships.manage(getPool(),id,req.sdcActor.doctorId,req.sdcActor.userId,req.body.doctor_id,req.body.action);
 if(r.status==='ok')return res.redirect(303,'/clinic/doctors?membership=updated');
 if(r.status==='forbidden')return res.sendStatus(403);
 return res.status(409).send(r.status==='bookings'?'لا يمكن تعليق العضوية بوجود مواعيد قائمة. راجعها أولًا.':'تعذّر تغيير حالة العضوية؛ حدّث الصفحة.');
}));
routers.clinic.get('/doctor-details',wrap(async(req,res)=>{
 const id=manager(req);if(!id)return res.sendStatus(403);
 const doctorId=svc.num(req.query.id);
 if(!doctorId)return res.redirect(303,'/clinic/doctors');
 const profile=await schedules.read(getPool(),id,doctorId);if(!profile)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('clinic/doctor-details',data(req,res,'clinic/doctor-details',{profile,message:msg(req),WEEKDAYS:schedules.WEEKDAYS}));
}));
routers.clinic.post('/doctor-details',wrap(async(req,res)=>{
 const id=manager(req);if(!id)return res.sendStatus(403);
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 const doctorId=svc.num(req.body.doctor_id);if(!doctorId)return res.sendStatus(422);
 const result=await schedules.save(getPool(),id,doctorId,req.sdcActor.userId,req.body);
 if(result.status!=='ok'){
  const errors={invalid:'يرجى مراجعة اليوم وساعات البداية والنهاية أو بيانات الإجازة.',forbidden:'لا تملك صلاحية إدارة دوام هذا الطبيب.',stale:'هذه الفترة تغيرت من جهاز آخر. حدّث الصفحة.',conflict:'تتعارض الفترة مع دوام آخر للطبيب (في نفس العيادة أو عيادة أخرى).',absence_overlap:'هناك إجازة مسجلة تتداخل مع التاريخ المحدد.',bookings_affected:'يوجد موعد قائم يتأثر بحذف الفترة أو إضافة الغياب أو تعديل الدوام. عالج المواعيد أولًا.'};
  const status=result.status==='forbidden'?403:['conflict','absence_overlap','bookings_affected','stale'].includes(result.status)?409:422;
  const profile=await schedules.read(getPool(),id,doctorId);
  if(!profile)return res.sendStatus(404);
  res.set('Cache-Control','no-store');
  return res.status(status).render('clinic/doctor-details',data(req,res,'clinic/doctor-details',{profile,WEEKDAYS:schedules.WEEKDAYS,error:errors[result.status]||'تعذّر تعديل جدول الطبيب. راجع البيانات.'}));
 }
 return res.redirect(303,`/clinic/doctor-details?id=${doctorId}&saved=1`);
}));
routers.doctor.get('/schedule',wrap(async(req,res)=>{
 const id=doctorClinic(req);if(!id)return res.sendStatus(403);
 const profile=await schedules.read(getPool(),id,req.sdcActor.doctorId);
 if(!profile)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('doctor/schedule',data(req,res,'doctor/schedule',{profile,WEEKDAYS:schedules.WEEKDAYS}));
}));
module.exports={patientRouter:routers.patient,doctorRouter:routers.doctor,clinicRouter:routers.clinic,staffRouter:routers.staff};
