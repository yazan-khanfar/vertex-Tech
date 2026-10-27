'use strict';
const express = require('express');
const {guard}=require('../auth/guard');
const {logoutTracked}=require('../auth/session');
const {getPool} = require('../../db/pool');
const pages = require('../../config/page-map.json');
const {issueCsrf,validateCsrf} = require('../security/csrf');
const {listDoctors,findDoctor,reviewDoctor} = require('./service');
const {listAudit,exportAudit,auditTypeLabel,auditTypeIcon} = require('./audit-service');
const router = express.Router();
const BODY = express.urlencoded({extended:false,limit:'12kb',parameterLimit:20});

function adminPageLocals(name,res,more={}) {
  const item=pages[`admin/${name}.html`];
  if(!item) throw new Error('Admin page missing from allowlist');
  const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
  const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
  return {currentPage:`admin/${name}.html`,role:'admin',navVariant:item.navVariant,
    drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
    navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),
    drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
    pendingClinicCount:res.locals.adminPendingClinics||0,
    adminCsrfToken:issueCsrf(res,'admin'),logoutCsrf:res.locals.logoutCsrf || '',
    currentUser:res.locals.currentUser||null,...more};
}
// Old admin entrypoint is retired; all accounts use the official login page.
router.get('/sign-in',(req,res)=>res.redirect(303,'/auth/login'));
router.post('/sign-in',(req,res)=>res.redirect(303,'/auth/login'));
const protectedAdmin=guard('admin');
function requireAdmin(req,res,next){return protectedAdmin(req,res,next);}
router.use(requireAdmin);
// Real count for the existing admin notification dropdown, no demo totals.
router.use(async(req,res,next)=>{try{
 const r=await getPool().query(`SELECT COUNT(*)::integer AS n FROM sdc."CLINIC" WHERE "Approval_Status"='pending'`);
 res.locals.adminPendingClinics=r.rows[0]?.n||0;return next();
}catch(e){console.error('[ADMIN_NOTIFICATIONS_FAILED]',e.code||'UNKNOWN');return next(e);}});
require('../clinic-onboarding/admin-routes').attach(router,{adminPageLocals,getPool,validateCsrf});
// Backward-compatible route for the existing Admin header form.
router.post('/sign-out',BODY,async(req,res)=>{
 if(!validateCsrf(req,'admin'))return res.status(403).send('رمز حماية غير صالح.');
 try{await logoutTracked(req,res,getPool());return res.redirect(303,'/auth/login');}
 catch(e){console.error('[LOGOUT_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذر إنهاء الجلسة.');}
});
// Audit log is a protected SSR page, not the original static demo placeholder.
router.get('/system-log',async(req,res,next)=>{
 try {
   const audit=await listAudit(getPool(),req.query);
   res.set('Cache-Control','no-store');
   return res.render('admin/system-log',adminPageLocals('system-log',res,{
     ...audit,auditTypeLabel,auditTypeIcon
   }));
 } catch(err){next(err);}
});
router.get('/system-log/export',async(req,res,next)=>{
 try {
   const result=await exportAudit(getPool(),req.query);
   if(result.tooMany)return res.status(422).type('text/plain').send('عدد السجلات كبير؛ يرجى تضييق الفلاتر قبل التصدير.');
   res.set('Cache-Control','no-store');
   res.set('Content-Disposition','attachment; filename="sdc-audit-log.csv"');
   return res.type('text/csv; charset=utf-8').send(result.csv);
 } catch(err){next(err);}
});
// Reuse the original detailed Super Admin clinic page instead of a sample/demo duplicate.
router.get('/clinic-details',async(req,res,next)=>{
 return require('../workspace/core').route(require('../workspace/admin').clinicDetails)(req,res,next);
});
router.get('/doctors',async(req,res,next)=>{
  return require('../workspace/core').route(require('../workspace/admin').doctors)(req,res,next);
});
router.get('/doctor-license-review',async(req,res,next)=>{
  try {
    const id=req.query.id;
    if(typeof id!=='string'|| !/^[1-9]\d{0,17}$/.test(id))return res.redirect(303,'/admin/doctors');
    const doctor=await findDoctor(getPool(),id);
    if(!doctor)return res.status(404).send('الطبيب غير موجود.');
    const result=req.query.result==='approved'?'approved':req.query.result==='rejected'?'rejected':null;
    res.set('Cache-Control','no-store');
    return res.render('admin/doctor-license-review',adminPageLocals('doctor-license-review',res,{doctor,result,formError:''}));
  }catch(e){next(e);}
});
router.post('/doctor-license-review',BODY,async(req,res,next)=>{
  if(!validateCsrf(req,'admin'))return res.status(403).send('انتهت صلاحية النموذج. ارجع لصفحة المراجعة وحاول من جديد.');
  try {
    const doctorId=req.body?.doctor_id;
    const result=await reviewDoctor(getPool(),{
      doctorId,adminUserId:req.adminUserId,decision:req.body?.decision,
      reason:req.body?.reason,checks:req.body
    });
    if(result.status==='ok')return res.redirect(303,`/admin/doctor-license-review?id=${doctorId}&result=${result.decision==='approve'?'approved':'rejected'}`);
    if(result.status==='unauthorized')return res.status(403).send('لا تملك صلاحية اعتماد الترخيص.');
    if(result.status==='not_found')return res.status(404).send('الطبيب غير موجود.');
    if(result.status==='already_reviewed')return res.status(409).send('تمت مراجعة هذا الترخيص بالفعل؛ حدّث الصفحة قبل أي إجراء.');
    const doctor=await findDoctor(getPool(),doctorId);
    if(!doctor)return res.status(404).send('الطبيب غير موجود.');
    return res.status(422).render('admin/doctor-license-review',adminPageLocals('doctor-license-review',res,{
      doctor,result:null,formError:result.status==='invalid_checks'?'يجب تأكيد صحة الرقم وتطابق الهوية والتخصص قبل الموافقة.':'اكتب سبب القرار من 8 إلى 1000 حرف وتحقق من المدخلات.'
    }));
  } catch(e) {next(e);}
});
module.exports=router;
