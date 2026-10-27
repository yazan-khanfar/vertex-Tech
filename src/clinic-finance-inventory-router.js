'use strict';
const express=require('express');
const pages=require('../config/page-map.json');
const {getPool}=require('../db/pool');
const {clinicId}=require('./clinic-settings-service');
const {sessionCsrf,validateSessionCsrf}=require('./auth/session');
const svc=require('./clinic-finance-inventory-service');
const router=express.Router();
router.use(['/inventory/add','/inventory/move','/invoices/payment'],express.urlencoded({extended:false,limit:'10kb',parameterLimit:20}));
function view(req,res,slug,data){
 const item=pages['clinic/'+slug+'.html'];
 const css=(k,h)=>item[k+'ActiveClasses'][h]?' '+item[k+'ActiveClasses'][h]:'';
 const aria=(k,h)=>item[k+'Aria'][h]==='page'?' aria-current="page"':'';
 res.set('Cache-Control','private, no-store');
 return res.render('clinic/'+slug,{currentPage:'clinic/'+slug+'.html',role:'clinic',navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
  navActiveClass:h=>css('nav',h),navAriaCurrent:h=>aria('nav',h),drawerActiveClass:h=>css('drawer',h),drawerAriaCurrent:h=>aria('drawer',h),
  currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',csrfToken:sessionCsrf(req),paymentRequestKey:require('node:crypto').randomUUID(),...data});
}
function scoped(req,res){const id=clinicId(req);if(!id)res.status(403).send('غير مصرح لعيادة أخرى.');return id;}
function err(next){return e=>{console.error('[CLINIC_FINANCE_STOCK]',e.code||'UNKNOWN');next(e);};}
router.get('/inventory',async(req,res,next)=>{const id=scoped(req,res);if(!id)return;
 try{return view(req,res,'inventory',{stock:await svc.inventory(getPool(),id,req.query.page),feedback:req.query.saved==='1'?'تم الحفظ بنجاح.':'',error:''});}catch(e){err(next)(e);}
});
router.post('/inventory/add',async(req,res,next)=>{const id=scoped(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 try{const r=await svc.addItem(getPool(),id,req.sdcActor.userId,req.body);
  if(r.status==='ok')return res.redirect(303,'/clinic/inventory?saved=1');
  return res.status(r.status==='invalid'?422:409).send(r.status==='duplicate'?'هذه المادة موجودة بالاسم والوحدة نفسها.':r.status==='forbidden'?'العيادة غير فعالة.':'راجع بيانات المادة والكمية وتاريخ الصلاحية.');
 }catch(e){err(next)(e);}
});
router.post('/inventory/move',async(req,res,next)=>{const id=scoped(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 try{const r=await svc.moveStock(getPool(),id,req.sdcActor.userId,req.body);
  if(r.status==='ok')return res.redirect(303,'/clinic/inventory?saved=1');
  return res.status(r.status==='invalid'?422:r.status==='not_found'?404:409).send(({insufficient:'لا يوجد رصيد كافٍ لإتمام الحركة.',unchanged:'الرصيد المطلوب مطابق للرصيد الحالي.',not_found:'هذه المادة غير موجودة في العيادة.',invalid:'الكمية أو الحركة غير صالحة.'})[r.status]||'تعذّر تنفيذ حركة المخزون.');
 }catch(e){err(next)(e);}
});
router.get('/invoices',async(req,res,next)=>{const id=scoped(req,res);if(!id)return;
 try{return view(req,res,'invoices',{finance:await svc.invoices(getPool(),id),feedback:req.query.saved==='1'?'تم تسجيل الدفعة بنجاح.':'',error:''});}catch(e){err(next)(e);}
});
router.post('/invoices/payment',async(req,res,next)=>{const id=scoped(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 try{await require('./workspace/billing').invoiceAction(req,{...req.body,action:'payment'});
  return res.redirect(303,'/clinic/invoices?saved=1');
 }catch(e){if(e.status)return res.status(e.status).render('shared/error',{message:e.message,back:'/clinic/invoices'});err(next)(e);}
});
router.get('/settlements',async(req,res,next)=>{const id=scoped(req,res);if(!id)return;
 try{return view(req,res,'settlements',{settlements:await svc.settlements(getPool(),id)});}catch(e){err(next)(e);}
});
module.exports=router;
