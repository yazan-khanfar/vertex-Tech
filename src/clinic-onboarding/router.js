'use strict';
const express=require('express');
const multer=require('multer');
const {getPool}=require('../../db/pool');
const {resolveSession}=require('../auth/guard');
const {sessionCsrf,validateSessionCsrf,setTrackedClinic}=require('../auth/session');
const svc=require('./service');
const router=express.Router();
const uploader=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:2,fields:18,parts:22}}).fields([{name:'license',maxCount:1},{name:'manager',maxCount:1}]);
async function doctor(req,res,next){try{const actor=await resolveSession(req,res);if(!actor)return res.redirect(303,'/auth/login');if(actor.role!=='doctor')return res.status(403).send('هذه الصفحة للطبيب المعتمد فقط.');return next();}catch(e){next(e);}}
router.use(doctor);
function clinicForm(req,res,c,error='',status=200){
 res.set('Cache-Control','no-store');return res.status(status).render('onboarding/doctor/clinic/create',{currentUser:res.locals.currentUser,logoutCsrf:res.locals.logoutCsrf,
   csrfToken:sessionCsrf(req),formError:error,clinic:c||{},editing:!!c});
}
router.get('/create',async(req,res,next)=>{try{
 const c=await svc.pendingClinic(getPool(),req.sdcActor.doctorId);
 if(c)return res.redirect(303,`/onboarding/doctor/clinic/application-status?id=${c.Clinic_ID}`);
 return clinicForm(req,res,null);
}catch(e){next(e);}});
router.get('/application-status',async(req,res,next)=>{try{
 const c=await svc.myClinic(getPool(),req.sdcActor.doctorId,req.query.id&&/^[1-9]\d{0,17}$/.test(req.query.id)?req.query.id:null);
 if(!c)return res.redirect(303,'/onboarding/doctor/clinic/create');
 return res.set('Cache-Control','no-store').render('onboarding/doctor/clinic/application-status',{
  clinic:c,status:svc.labelStatus(c),csrfToken:sessionCsrf(req),logoutCsrf:res.locals.logoutCsrf,currentUser:res.locals.currentUser,
  documents:await svc.clinicDocs(getPool(),c.Clinic_ID),feedback:req.query.saved==='1'?'تم إرسال الطلب للمراجعة بنجاح.':'',error:''});
}catch(e){next(e);}});
function upload(req,res,next){uploader(req,res,err=>{if(err)return res.status(422).send('تعذر رفع المرفق. الحد الأقصى 5MB لكل ملف وملفان فقط.');next();});}
router.post('/create',upload,async(req,res,next)=>{
 if(!validateSessionCsrf(req))return res.status(403).send('نموذج الحماية غير صالح؛ حدّث الصفحة.');
 try{
  const result=await svc.submitClinic(getPool(),req.sdcActor,req.body,req.files);
  if(result.status==='ok')return res.redirect(303,`/onboarding/doctor/clinic/application-status?id=${result.clinicId}&saved=1`);
  if(result.status==='duplicate')return res.redirect(303,`/onboarding/doctor/clinic/application-status?id=${result.clinicId}`);
  return clinicForm(req,res,req.body,result.error||'تعذّر إنشاء الطلب.',result.status==='forbidden'?403:422);
 }catch(error){console.error('[CLINIC_APPLICATION_FAILED]',error.code||error.message);
  return clinicForm(req,res,req.body,error.code==='23505'?'رقم ترخيص المنشأة مستخدم بالفعل.': 'تعذّر إرسال الطلب. تأكد من البيانات وحاول مجددًا.',error.code==='23505'?409:503);}
});
router.post('/application-status',upload,async(req,res,next)=>{
 if(!validateSessionCsrf(req))return res.status(403).send('رمز النموذج غير صالح.');
 try{
  const result=await svc.submitClinic(getPool(),req.sdcActor,req.body,req.files,req.body?.clinic_id);
  if(result.status==='ok')return res.redirect(303,`/onboarding/doctor/clinic/application-status?id=${result.clinicId}&saved=1`);
  const c=await svc.myClinic(getPool(),req.sdcActor.doctorId,req.body?.clinic_id);
  if(!c)return res.status(404).send('الطلب غير موجود.');
  return res.status(422).render('onboarding/doctor/clinic/application-status',{clinic:c,status:svc.labelStatus(c),csrfToken:sessionCsrf(req),documents:await svc.clinicDocs(getPool(),c.Clinic_ID),logoutCsrf:res.locals.logoutCsrf,currentUser:res.locals.currentUser,
   feedback:'',error:result.error||'لا يمكن تعديل الطلب بهذه الحالة.'});
 }catch(error){console.error('[CLINIC_RESUBMIT_FAILED]',error.code||error.message);return res.status(error.code==='23505'?409:503).send(error.code==='23505'?'رقم الترخيص مستخدم بالفعل.':'تعذر تحديث الطلب.');}
});
router.get('/document/:id',async(req,res,next)=>{
 try{
  const doc=await svc.getDocument(getPool(),req.params.id);
  if(!doc||String(doc.Manager_Doctor_ID)!==String(req.sdcActor.doctorId))return res.sendStatus(404);
  const filepath=svc.documentPath(doc.File_Reference);if(!filepath)return res.sendStatus(404);
  const mime=filepath.endsWith('.pdf')?'application/pdf':filepath.endsWith('.png')?'image/png':'image/jpeg';
  res.set({'Cache-Control':'private, no-store','Content-Type':mime,'X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="clinic-document"'});
  return res.sendFile(filepath,e=>{if(e&&!res.headersSent)next(e);});
 }catch(e){next(e);}
});
module.exports=router;
