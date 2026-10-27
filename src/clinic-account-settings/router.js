'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const pages=require('../../config/page-map.json');
const {sessionCsrf,validateSessionCsrf,listTrackedSessions}=require('../auth/session');
const {passwordError}=require('../password-reset/profile-destinations');
const {mfaViewFor}=require('../mfa/profile-page');
const service=require('./service');
const router=express.Router();
const body=express.urlencoded({extended:false,limit:'8kb',parameterLimit:8});
const alerts={
 contact:'تم حفظ بيانات تسجيل الدخول بنجاح.',language:'تم حفظ اللغة المفضلة للحساب.',
 invalid:'راجع البريد الإلكتروني ورقم الهاتف وأعد المحاولة.',password:'كلمة المرور الحالية غير صحيحة.',
 duplicate:'البريد الإلكتروني مستخدم في حساب آخر.',unavailable:'تعذّر حفظ التعديل حاليًا. حاول مجددًا.',
 csrf:'انتهت صلاحية النموذج. حدّث الصفحة وحاول من جديد.'
};
function urlFor(code){return '/clinic/account-settings?account_result='+encodeURIComponent(code)+'#'+(code==='language'?'sdc-language':'sdc-contact');}
async function renderSettings(req,res,status=200,code=''){
 const accountUser=await service.loadAccount(getPool(),req.sdcActor.userId);
 if(!accountUser)return res.sendStatus(404);
 const map=pages['clinic/account-settings.html'];
 const css=(k,h)=>map[k+'ActiveClasses'][h]?' '+map[k+'ActiveClasses'][h]:'';
 const aria=(k,h)=>map[k+'Aria'][h]==='page'?' aria-current="page"':'';
 res.set('Cache-Control','no-store');
 return res.status(status).render('clinic/account-settings',{
  accountUser,accountSettingsAlert:alerts[code]||'',accountSettingsOk:['contact','language'].includes(code),
  currentPage:'clinic/account-settings.html',role:'clinic',navVariant:map.navVariant,drawerVariant:map.drawerVariant,footerVariant:map.footerVariant,
  navActiveClass:h=>css('nav',h),navAriaCurrent:h=>aria('nav',h),drawerActiveClass:h=>css('drawer',h),drawerAriaCurrent:h=>aria('drawer',h),
  currentUser:res.locals.currentUser,activeClinic:res.locals.activeClinic,logoutCsrf:res.locals.logoutCsrf,
  passwordChangeCsrf:sessionCsrf(req),passwordChangeError:passwordError(req.query?.password_error),
  passwordChangeReference:/^[A-F0-9]{8}$/.test(String(req.query?.password_reference||''))?req.query.password_reference:'',
  mfaView:await mfaViewFor(req),accountSessions:await listTrackedSessions(getPool(),req.sdcActor.userId,req.sdcSession.sessionId),
  sessionActionCsrf:sessionCsrf(req),sessionActionMessage:req.query?.sessions==='updated'?'تم تحديث الجلسات بنجاح.':''
 });
}
router.get('/account-settings',async(req,res,next)=>{
 try{return await renderSettings(req,res,200,String(req.query?.account_result||''));}catch(err){next(err);}
});
router.post('/account-settings',body,async(req,res,next)=>{
 const action=String(req.body?.action||'');if(!['contact','language'].includes(action))return res.sendStatus(422);
 if(!validateSessionCsrf(req))return res.redirect(303,urlFor('csrf'));
 try{
  const r=action==='contact'
   ?await service.changeContact(getPool(),req.sdcActor.userId,req.body)
   :await service.changeLanguage(getPool(),req.sdcActor.userId,req.body.language);
  if(r.status==='ok')return res.redirect(303,urlFor(action));
  if(r.status==='not_found')return res.sendStatus(403);
  return res.redirect(303,urlFor(r.status));
 }catch(err){console.error('[CLINIC_ACCOUNT_SETTINGS_FAILED]',action,err.code||'UNKNOWN');return res.redirect(303,urlFor('unavailable'));}
});
module.exports=router;
