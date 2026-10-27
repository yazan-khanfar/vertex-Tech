'use strict';
const express=require('express');const pages=require('../../config/page-map.json');
const {getPool}=require('../../db/pool');const service=require('./service');const {sessionCsrf}=require('../auth/session');
const router=express.Router();
function context(req){const id=String(req.sdcSession?.clinicId||'');const doc=String(req.sdcActor?.doctorId||'');return service.validId(id)&&service.validId(doc)&&req.sdcClinics?.some(c=>c.id===id)?{id,doc}:null;}
function locals(req,res,slug,additional){const p=pages[`${slug}.html`];
 const css=(type,href)=>p[type+'ActiveClasses'][href]?' '+p[type+'ActiveClasses'][href]:'';
 const aria=(type,href)=>p[type+'Aria'][href]==='page'?' aria-current="page"':'';
 return {currentPage:`${slug}.html`,role:'doctor',navVariant:p.navVariant,drawerVariant:p.drawerVariant,footerVariant:p.footerVariant,
 navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
 currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',csrfToken:sessionCsrf(req),...additional};}
const route=handler=>(req,res)=>Promise.resolve().then(()=>handler(req,res)).catch(e=>{console.error('[DOCTOR_WORKSPACE_READ_FAILED]',req.path,e.code||e.message);return res.headersSent?undefined:res.status(503).send('تعذّر تحميل البيانات من قاعدة البيانات. لم يتم تغيير أي سجلات.');});
router.get('/index',route(async(req,res)=>{const c=context(req);if(!c)return res.sendStatus(403);
 const overview=await service.dashboard(getPool(),c.doc,c.id);
 res.set('Cache-Control','no-store');return res.render('doctor/index',locals(req,res,'doctor/index',{overview}));}));
router.get('/patients',route(async(req,res)=>{const c=context(req);if(!c)return res.sendStatus(403);
 const patients=await service.patients(getPool(),c.doc,c.id);
 res.set('Cache-Control','no-store');return res.render('doctor/patients',locals(req,res,'doctor/patients',{patients}));}));
router.get('/patient-details',route(async(req,res)=>{const c=context(req);if(!c)return res.sendStatus(403);
 const patient=await service.patientDetails(getPool(),c.doc,c.id,req.query.id);
 if(!patient)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('doctor/patient-details',locals(req,res,'doctor/patient-details',{patient}));}));
router.get('/followups',route(async(req,res)=>{const c=context(req);if(!c)return res.sendStatus(403);
 const followups=await service.followups(getPool(),c.doc,c.id);
 res.set('Cache-Control','no-store');return res.render('doctor/followups',locals(req,res,'doctor/followups',{followups}));}));
router.get('/treatment-plans',route(async(req,res)=>{const c=context(req);if(!c)return res.sendStatus(403);
 const [plans,patients]=await Promise.all([service.treatmentPlans(getPool(),c.doc,c.id),service.patients(getPool(),c.doc,c.id)]);
 res.set('Cache-Control','no-store');return res.render('doctor/treatment-plans',locals(req,res,'doctor/treatment-plans',{plans,patients}));}));
router.get('/treatment-plan-details',route(async(req,res)=>{const c=context(req);if(!c)return res.sendStatus(403);
 const plan=await service.treatmentPlanDetails(getPool(),c.doc,c.id,req.query.id);
 if(!plan)return res.sendStatus(404);
 res.set('Cache-Control','no-store');return res.render('doctor/treatment-plan-details',locals(req,res,'doctor/treatment-plan-details',{plan}));}));
module.exports=router;
