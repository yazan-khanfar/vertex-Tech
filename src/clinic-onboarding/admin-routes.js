'use strict';
const fs=require('node:fs');
const service=require('./service');
const BODY=require('express').urlencoded({extended:false,limit:'12kb',parameterLimit:20});
function attach(router,{adminPageLocals,getPool,validateCsrf}){
 router.get('/approvals',async(req,res,next)=>{try{
  const clinics=await service.listClinics(getPool());res.set('Cache-Control','no-store');
  return res.render('admin/approvals',adminPageLocals('approvals',res,{clinics}));
 }catch(e){next(e);}});
 router.get('/clinic-application-details',async(req,res,next)=>{try{
  const clinic=await service.findClinic(getPool(),req.query.id);
  if(!clinic)return res.status(404).send('طلب العيادة غير موجود.');
  res.set('Cache-Control','no-store');return res.render('admin/clinic-application-details',adminPageLocals('clinic-application-details',res,{
   clinic,documents:await service.clinicDocs(getPool(),clinic.Clinic_ID),
   reviewResult:req.query.result==='updated'?'تم تسجيل قرار المراجعة بنجاح.':'',reviewError:''}));
 }catch(e){next(e);}});
 router.post('/clinic-application-details',BODY,async(req,res,next)=>{
  if(!validateCsrf(req,'admin'))return res.status(403).send('انتهت صلاحية نموذج المراجعة؛ حدّث الصفحة.');
  const id=req.body?.clinic_id;
  try{
   const result=await service.reviewClinic(getPool(),req.sdcActor,id,req.body?.decision,req.body?.reason,req.body);
   if(result.status==='ok')return res.redirect(303,`/admin/clinic-application-details?id=${encodeURIComponent(id)}&result=updated`);
   if(result.status==='not_found')return res.sendStatus(404);
   if(result.status==='forbidden')return res.sendStatus(403);
   const clinic=await service.findClinic(getPool(),id);if(!clinic)return res.sendStatus(404);
   const messages={invalid:'اكتب سببًا واضحًا لا يقل عن 8 أحرف، وحدد القرار.',checks:'يجب تأكيد جميع فحوص البيانات والمرفقات قبل الاعتماد.',documents:'لا يمكن الاعتماد قبل رفع الوثيقتين المطلوبتين.',reviewed:'سبق اتخاذ القرار النهائي في هذا الطلب.'};
   return res.status(422).render('admin/clinic-application-details',adminPageLocals('clinic-application-details',res,{
    clinic,documents:await service.clinicDocs(getPool(),id),reviewResult:'',reviewError:messages[result.status]||'بيانات غير صالحة.'}));
  }catch(error){console.error('[CLINIC_REVIEW_FAILED]',error.code||error.message);return res.status(503).send('تعذّر إتمام المراجعة حاليًا. راجع سجل الخادم.');}
 });
 router.get('/clinic-document/:id',async(req,res,next)=>{try{
  const document=await service.getDocument(getPool(),req.params.id);if(!document)return res.sendStatus(404);
  const filepath=service.documentPath(document.File_Reference);if(!filepath)return res.sendStatus(404);
  const mime=filepath.endsWith('.pdf')?'application/pdf':filepath.endsWith('.png')?'image/png':'image/jpeg';
  res.set({'Cache-Control':'private, no-store','Content-Type':mime,'X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="clinic-document"'});
  return res.sendFile(filepath,e=>{if(e&&!res.headersSent)next(e);});
 }catch(e){next(e);}});
}
module.exports={attach};
