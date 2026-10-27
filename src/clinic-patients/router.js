'use strict';
const express=require('express');
const pages=require('../../config/page-map.json');
const {getPool}=require('../../db/pool');
const {clinicId}=require('../clinic-settings-service');
const {sessionCsrf,validateSessionCsrf}=require('../auth/session');
const svc=require('./service');
const router=express.Router();
router.use('/patients',express.urlencoded({extended:false,limit:'16kb',parameterLimit:30}));
function locals(page,req,res,data){
 const key=`clinic/${page}.html`,item=pages[key];
 const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
 const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
 return {currentPage:key,role:'clinic',navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
 navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
 currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',csrfToken:sessionCsrf(req),...data};
}
function permitted(req,res){const id=clinicId(req);if(!id)res.status(403).send('لا تملك صلاحية الاطلاع على مرضى هذه العيادة.');return id;}
router.get('/patients',async(req,res,next)=>{const id=permitted(req,res);if(!id)return;
 try{const patients=await svc.list(getPool(),id);res.set('Cache-Control','private, no-store');return res.render('clinic/patients',locals('patients',req,res,{patients,message:req.query.created==='1'?'تم حفظ ملف المريض بنجاح.':'',error:''}));}
 catch(e){console.error('[CLINIC_PATIENT_LIST_FAILED]',e.code||'UNKNOWN');next(e);}
});
router.post('/patients',async(req,res,next)=>{const id=permitted(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.status(403).send('انتهت صلاحية نموذج الحفظ. حدّث الصفحة وحاول مجددًا.');
 try{const result=await svc.create(getPool(),id,req.sdcActor.userId,req.body);
  if(result.status==='ok')return res.redirect(303,`/clinic/patient-details?patient=${encodeURIComponent(result.id)}`);
  const messages={invalid:'راجع الاسم وتاريخ الميلاد والهاتف والبيانات الصحية المدخلة.',exists:'هناك ملف مريض بهذه البيانات أو بريد مرتبط بحساب موجود. لأمان البيانات لا يتم ربطه تلقائيًا؛ تحقّق من هويته قبل المتابعة.',role_missing:'دور المريض غير مجهّز في قاعدة البيانات.',forbidden:'لا تملك صلاحية إضافة مريض لهذه العيادة.'};
  const patients=await svc.list(getPool(),id);
  return res.status(result.status==='invalid'?422:409).render('clinic/patients',locals('patients',req,res,{patients,message:'',error:messages[result.status]||'تعذّر إضافة المريض.'}));
 }catch(e){console.error('[CLINIC_PATIENT_CREATE_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذّر حفظ ملف المريض حاليًا. لم يتم اعتماد العملية.');}
});
router.get('/patient-details',async(req,res,next)=>{const clinic=permitted(req,res);if(!clinic)return;
 try{if(req.query.id&&req.query.patient&&req.query.id!==req.query.patient)return res.status(400).send('معرّف المريض غير متطابق.');
 const patient=await svc.detail(getPool(),clinic,req.query.id||req.query.patient);
 if(!patient)return res.status(404).send('هذا الملف غير موجود في عيادتك.');
 res.set('Cache-Control','private, no-store');return res.render('clinic/patient-details',locals('patient-details',req,res,{patient}));
 }catch(e){console.error('[CLINIC_PATIENT_DETAILS_FAILED]',e.code||'UNKNOWN');next(e);}
});
module.exports=router;
