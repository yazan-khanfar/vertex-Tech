'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const pages=require('../../config/page-map.json');
const {sessionCsrf,validateSessionCsrf}=require('../auth/session');
const {num,localNow}=require('../appointments/service');
const svc=require('./service');
const clinicRouter=express.Router();const doctorRouter=express.Router();const staffRouter=express.Router();
// Avoid consuming POST bodies for unrelated role routes (jobs, files, inventory, etc.).
const operationsForm=express.urlencoded({extended:false,limit:'16kb',parameterLimit:15});
clinicRouter.use('/operations/action',operationsForm);
doctorRouter.use('/visit/action',operationsForm);
staffRouter.use('/operations/action',operationsForm);
function locals(req,res,view,extras={}){
 const item=pages[view+'.html'];
 const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
 const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
 return {currentPage:view+'.html',role:item.role,navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
 navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
 currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',
 csrfToken:sessionCsrf(req),...extras};
}
const managerId=req=>{const id=String(req.sdcSession?.clinicId||'');return num(id)&&req.sdcClinics?.some(c=>c.id===id&&c.manager)?id:null;};
const physicianClinic=req=>{const id=String(req.sdcSession?.clinicId||'');return num(id)&&req.sdcClinics?.some(c=>c.id===id)?id:null;};
const ensureCsrf=(req,res)=>{if(validateSessionCsrf(req))return true;res.status(403).send('طلب غير صالح. حدّث الصفحة وأعد المحاولة.');return false;};
function handle(fn){return (req,res,next)=>Promise.resolve(fn(req,res)).catch(error=>{
 console.error('[DAILY_OPERATIONS_FAILED]',error.code||'UNKNOWN',error.constraint||'');
 if(['23514','23505','23503'].includes(error.code))return res.status(409).send('لا يمكن تنفيذ التغيير بسبب قيد في قاعدة البيانات. حدّث الصفحة.');
 return res.status(503).send('تعذّر معالجة العملية. تحقق من تثبيت ترحيل قاعدة البيانات 003 ثم راجع سجل التشغيل.');
});}
const messages={check_in:'تم تسجيل وصول المريض.',no_show:'تم تسجيل عدم الحضور.',start:'تم بدء الزيارة.',save:'تم حفظ الملاحظات.',complete:'تم إكمال الزيارة.'};
clinicRouter.get('/operations',handle(async(req,res)=>{
 const id=managerId(req);if(!id)return res.sendStatus(403);
 const date=localNow().date;const entries=await svc.daily(getPool(),id,date);
 res.set('Cache-Control','no-store');return res.render('clinic/operations',locals(req,res,'clinic/operations',{
  entries,counters:svc.counters(entries),today:date,
  message:req.query.done==='1'?'تم حفظ الإجراء في قاعدة البيانات.':'',
  error:req.query.error==='state'?'هذه العملية غير متاحة لحالة الموعد الحالية.':''}));
}));
clinicRouter.post('/operations/action',handle(async(req,res)=>{
 const id=managerId(req);if(!id)return res.sendStatus(403);
 if(!ensureCsrf(req,res))return;
 const result=await svc.clinicAction(getPool(),{
  clinicId:id,userId:req.sdcActor.userId,bookingId:req.body.booking_id,action:req.body.action});
 if(result.status==='not_found')return res.sendStatus(404);
 if(result.status!=='ok')return res.redirect(303,'/clinic/operations?error=state');
 return res.redirect(303,'/clinic/operations?done=1');
}));
doctorRouter.get('/visit',handle(async(req,res)=>{
 const id=physicianClinic(req);if(!id)return res.sendStatus(403);
 if(!num(req.query.booking_id))return res.redirect(303,'/doctor/appointments');
 const booking=await svc.visitContext(getPool(),id,req.sdcActor.doctorId,req.query.booking_id);
 if(!booking)return res.sendStatus(404);
 if(!['confirmed','in_progress','completed'].includes(booking.status))return res.status(409).send('الموعد غير جاهز للزيارة.');
 res.set('Cache-Control','no-store');return res.render('doctor/visit',locals(req,res,'doctor/visit',{
  liveVisit:booking,clinical:booking.visit_id?await require('../doctor-workspace/clinical-service').visitDetails(getPool(),{id,doc:String(req.sdcActor.doctorId)},booking.id):null,visitMessage:req.query.saved==='1'||req.query.clinical_saved==='1'?'تم حفظ بيانات الزيارة.':''}));
}));
doctorRouter.post('/visit/action',handle(async(req,res)=>{
 const id=physicianClinic(req);if(!id)return res.sendStatus(403);
 if(!ensureCsrf(req,res))return;
 const outcome=await svc.doctorAction(getPool(),{
  clinicId:id,doctorId:req.sdcActor.doctorId,userId:req.sdcActor.userId,
  bookingId:req.body.booking_id,action:req.body.action,complaint:req.body.chief_complaint,
  examination:req.body.examination_notes});
 if(outcome.status==='not_found')return res.sendStatus(404);
 if(outcome.status!=='ok')return res.status(409).send(
  outcome.status==='incomplete'?'لا يمكن إنهاء الزيارة قبل توثيق الشكوى وملاحظات الفحص.':'تعذّر تنفيذ الإجراء في حالة الموعد الحالية.');
 return res.redirect(303,`/doctor/visit?booking_id=${encodeURIComponent(outcome.id)}&saved=1`);
}));
staffRouter.post('/operations/action',handle(async(req,res)=>{
 const id=String(req.sdcSession?.clinicId||'');
 if(!num(id)||!req.sdcClinics?.some(c=>c.id===id))return res.sendStatus(403);
 if(!ensureCsrf(req,res))return;
 if(req.body.action!=='check_in')return res.sendStatus(403);
 const permission=await getPool().query(`SELECT sdc.sdc_can($1::bigint,$2::bigint,'appointments.manage') AS allowed`,[req.sdcActor.userId,id]);
 if(permission.rows[0]?.allowed!==true)return res.status(403).send('لا تملك صلاحية استقبال المرضى.');
 const result=await svc.clinicAction(getPool(),{
  clinicId:id,userId:req.sdcActor.userId,bookingId:req.body.booking_id,action:'check_in'});
 if(result.status==='not_found')return res.sendStatus(404);
 if(result.status!=='ok')return res.redirect(303,'/staff/appointments?error=state');
 return res.redirect(303,'/staff/appointments?saved=1');
}));
module.exports={clinicRouter,doctorRouter,staffRouter};
