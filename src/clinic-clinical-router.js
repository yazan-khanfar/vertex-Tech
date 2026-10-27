'use strict';
const express=require('express');
const pages=require('../config/page-map.json');
const {getPool}=require('../db/pool');
const {clinicId}=require('./clinic-settings-service');
const {localNow}=require('./appointments/service');
const svc=require('./clinic-clinical-service');
const router=express.Router();
function locals(req,res,slug,extra){
 const item=pages[slug+'.html'];
 return {currentPage:slug+'.html',role:'clinic',navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
  navActiveClass:href=>item.navActiveClasses[href]?' '+item.navActiveClasses[href]:'',
  navAriaCurrent:href=>item.navAria[href]==='page'?' aria-current="page"':'',
  drawerActiveClass:href=>item.drawerActiveClasses[href]?' '+item.drawerActiveClasses[href]:'',
  drawerAriaCurrent:href=>item.drawerAria[href]==='page'?' aria-current="page"':'',
  currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,
  logoutCsrf:res.locals.logoutCsrf||'',...extra};
}
function handler(fn){return (req,res,next)=>Promise.resolve(fn(req,res)).catch(e=>{console.error('[CLINIC_CLINICAL_READ_FAILED]',e.code||'UNKNOWN');res.status(503).send('تعذّر تحميل بيانات العيادة حاليًا. لم يتم تغيير أي بيانات.');});}
function activeId(req,res){const id=clinicId(req);if(!id){res.sendStatus(403);return null;}return id;}
router.get('/treatment-plans',handler(async(req,res)=>{const id=activeId(req,res);if(!id)return;
 const plans=await svc.listPlans(getPool(),id);
 res.set('Cache-Control','no-store');return res.render('clinic/treatment-plans',locals(req,res,'clinic/treatment-plans',{plans}));
}));
router.get('/treatment-plan-details',handler(async(req,res)=>{const id=activeId(req,res);if(!id)return;
 const plan=await svc.planDetails(getPool(),id,req.query.id);
 if(!plan)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('clinic/treatment-plan-details',locals(req,res,'clinic/treatment-plan-details',{plan}));
}));
router.get('/recalls',handler(async(req,res)=>{const id=activeId(req,res);if(!id)return;
 const recalls=await svc.listRecalls(getPool(),id,localNow().date);
 res.set('Cache-Control','no-store');return res.render('clinic/recalls',locals(req,res,'clinic/recalls',{recalls}));
}));
router.get('/visit-checkout',handler(async(req,res)=>{const id=activeId(req,res);if(!id)return;
 const visit=await svc.completedVisit(getPool(),id,req.query.visit_id);
 if(!visit)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('clinic/visit-checkout',locals(req,res,'clinic/visit-checkout',{visit}));
}));
router.get('/doctor-report',handler(async(req,res)=>{const id=activeId(req,res);if(!id)return;
 const report=await svc.reportDetails(getPool(),id,req.query.visit_id);
 if(!report)return res.status(404).send('التقرير الطبي غير معتمد أو لا يتبع هذه العيادة.');
 res.set('Cache-Control','no-store');return res.render('clinic/doctor-report',locals(req,res,'clinic/doctor-report',{report}));
}));
module.exports=router;
