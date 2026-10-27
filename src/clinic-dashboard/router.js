'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const pages=require('../../config/page-map.json');
const {clinicId}=require('../clinic-settings-service');
const dashboard=require('./service');
const router=express.Router();
router.get('/index',async(req,res,next)=>{
 const id=clinicId(req);
 if(!id)return res.status(403).send('لا تملك صلاحية إدارة هذه العيادة.');
 try{
  const result=await dashboard.load(getPool(),id);
  if(!result)return res.sendStatus(404);
  const item=pages['clinic/index.html'];
  const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
  const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
  res.set('Cache-Control','private, no-store');
  return res.render('clinic/index',{dashboard:result,currentPage:'clinic/index.html',role:'clinic',
   navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
   navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),
   drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
   currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||''});
 }catch(e){console.error('[CLINIC_DASHBOARD_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذّر تحميل لوحة العيادة. راجع سجل التشغيل.');}
});
module.exports=router;
