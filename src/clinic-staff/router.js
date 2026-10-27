'use strict';
const express=require('express');const pages=require('../../config/page-map.json');
const {getPool}=require('../../db/pool');const {clinicId}=require('../clinic-settings-service');
const {sessionCsrf,validateSessionCsrf}=require('../auth/session');const svc=require('./service');
const router=express.Router();router.use('/staff',express.urlencoded({extended:false,limit:'16kb',parameterLimit:50}));
const local=(req,res,extra={})=>{const key='clinic/staff.html',item=pages[key],css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'',aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
 return {currentPage:key,role:'clinic',navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
 navActiveClass:h=>css('nav',h),navAriaCurrent:h=>aria('nav',h),drawerActiveClass:h=>css('drawer',h),drawerAriaCurrent:h=>aria('drawer',h),currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',csrfToken:sessionCsrf(req),staff:[],message:'',error:'',...extra};};
router.get('/specialties',async(req,res,next)=>{const clinic=clinicId(req);if(!clinic)return res.sendStatus(403);
 try{const specialties=await require('./specialties').list(getPool(),clinic);
 const key='clinic/specialties.html',item=pages[key],css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'',aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
 res.set('Cache-Control','private, no-store');return res.render('clinic/specialties',{currentPage:key,role:'clinic',navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
 navActiveClass:h=>css('nav',h),navAriaCurrent:h=>aria('nav',h),drawerActiveClass:h=>css('drawer',h),drawerAriaCurrent:h=>aria('drawer',h),
 currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',specialties});
 }catch(e){next(e);}
});
router.get('/staff',async(req,res,next)=>{const clinic=clinicId(req);if(!clinic)return res.sendStatus(403);
 try{const staff=await svc.list(getPool(),clinic);res.set('Cache-Control','private, no-store');return res.render('clinic/staff',local(req,res,{staff,message:req.query.saved==='1'?'تم حفظ التعديل بنجاح.':'',error:''}));}catch(e){next(e);}
});
router.post('/staff',async(req,res,next)=>{const clinic=clinicId(req);if(!clinic)return res.sendStatus(403);
 if(!validateSessionCsrf(req))return res.status(403).send('انتهت صلاحية النموذج؛ حدّث الصفحة.');
 try{const r=await svc.save(getPool(),clinic,req.sdcActor.userId,req.body);if(r.status==='ok')return res.redirect(303,'/clinic/staff?saved=1');
 const messages={invalid:'راجع البيانات وكلمة المرور (12 حرفًا على الأقل) والصلاحيات.',duplicate:'هذا البريد مسجل بالفعل. لا يمكن ربط حساب موجود بدون موافقة صاحب الحساب.',forbidden:'لا تملك صلاحية إدارة موظفي هذه العيادة.',stale:'حالة الموظف تغيرت؛ حدّث الصفحة.',not_found:'هذا الموظف غير مرتبط بالعيادة.'};
 const staff=await svc.list(getPool(),clinic);return res.status(r.status==='invalid'?422:409).render('clinic/staff',local(req,res,{staff,error:messages[r.status]||'تعذّر حفظ العملية.'}));
 }catch(e){console.error('[CLINIC_STAFF_SAVE_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذّر حفظ بيانات الموظف حاليًا. لم تُعتمد العملية.');}
});
module.exports=router;
