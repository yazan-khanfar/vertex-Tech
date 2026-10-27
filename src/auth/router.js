'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const {issueCsrf,validateCsrf}=require('../security/csrf');
const {createTrackedSession,getSession,dropSession,setTrackedClinic,validateSessionCsrf,logoutTracked,startMfaChallenge,getMfaChallenge,failMfaChallenge,finishMfaChallenge}=require('./session');
const {checkSecondFactor}=require('../mfa/service');
function encryptionKey(){if(!/^[a-fA-F0-9]{64}$/.test(process.env.MFA_ENCRYPTION_KEY||''))throw Error('MFA_ENCRYPTION_KEY missing');}
const {authenticate,loadAccount,clinicsFor,redirectFor}=require('./service');
const router=express.Router();
const BODY=express.urlencoded({extended:false,limit:'8kb',parameterLimit:8});
const attempts=new Map();
function loginPage(req,res,status=200,error='',email=''){
 res.set('Cache-Control','no-store');
 return res.status(status).render('auth/login',{loginCsrf:issueCsrf(res,'login'),loginError:error,loginEmail:email,loginSuccess:req.query.password_changed==='1'&&!error});
}
function throttle(key){
 const now=Date.now();
 if(attempts.size>1000)for(const [k,v] of attempts)if(now-v.at>15*60*1000)attempts.delete(k);
 const state=attempts.get(key);
 const next=state&&now-state.at<15*60*1000?{at:state.at,n:state.n+1}:{at:now,n:1};
 attempts.set(key,next);
 return next.n<=10;
}
router.get('/login',(req,res)=>{
 if(getSession(req))return res.redirect(303,'/auth/continue');
 return loginPage(req,res);
});
router.post('/login',BODY,async(req,res)=>{
 const email=typeof req.body?.email==='string'?req.body.email.slice(0,254):'';
 if(!validateCsrf(req,'login'))return loginPage(req,res,403,'انتهت صلاحية نموذج الدخول. أعد المحاولة.',email);
 const key=String(req.ip||'unknown'); // bound failed attempts per client, independent of user-supplied email
 if(!throttle(key))return loginPage(req,res,429,'محاولات كثيرة. حاول لاحقًا.',email);
 try {
  const result=await authenticate(getPool(),req.body?.email,req.body?.password);
  if(result.status==='pending_license')return res.redirect(303,'/onboarding/doctor/verification-pending?login=pending');
  if(result.status==='rejected_license')return res.redirect(303,'/onboarding/doctor/license-status?login=rejected');
  if(result.status!=='ok'&&result.status!=='mfa_required'){
   const messages={pending_license:'رقم الترخيص ما زال قيد المراجعة. لا يمكنك دخول لوحة الطبيب حتى الاعتماد.',
     rejected_license:'تم رفض رقم الترخيص. راجع إدارة المنصة لاستكمال الإجراءات.',
     mfa_unavailable:'هذا الحساب يتطلب التحقق الثنائي. لن يتم السماح بالدخول قبل ربط MFA بشكل آمن.',
     disabled:'الحساب غير مفعل أو موقوف. تواصل مع الإدارة.'};
   return loginPage(req,res,401,messages[result.status]||'بيانات الدخول غير صحيحة.',email);
  }
  attempts.delete(key);
  if(result.status==='mfa_required'){
    encryptionKey(); // Fail closed if the encryption key is unavailable.
    if(getSession(req))dropSession(req,res);
    startMfaChallenge(res,result);return res.redirect(303,'/auth/mfa');
  }
  if(getSession(req))dropSession(req,res);
  await createTrackedSession(req,res,result,getPool());
  return res.redirect(303,'/auth/continue');
 }catch(error){console.error('Unified sign-in:',error.code||error.message);return loginPage(req,res,503,'تعذّر التحقق من بيانات الحساب. تحقق من اتصال قاعدة البيانات.',email);}
});

function mfaPage(req,res,status=200,error=''){
 res.set('Cache-Control','no-store');return res.status(status).render('auth/mfa',{csrfToken:issueCsrf(res,'login'),mfaError:error});
}
router.get('/mfa',(req,res)=>{
 if(getSession(req))return res.redirect(303,'/auth/continue');
 if(!getMfaChallenge(req))return res.redirect(303,'/auth/login');
 return mfaPage(req,res);
});
router.post('/mfa',BODY,async(req,res)=>{
 const challenge=getMfaChallenge(req);
 if(!challenge)return res.redirect(303,'/auth/login');
 if(!validateCsrf(req,'login'))return mfaPage(req,res,403,'انتهت صلاحية النموذج. حاول من جديد.');
 try{
  const result=await checkSecondFactor(getPool(),challenge.userId,req.body?.code);
  if(!result.ok){failMfaChallenge(req);return mfaPage(req,res,401,'رمز المصادقة أو الاسترداد غير صحيح، أو تم استخدامه من قبل.');}
  const actor=await loadAccount(getPool(),challenge.userId,true);
  if(!actor||actor.role!==challenge.role||!actor.mfaEnabled){finishMfaChallenge(req,res);return res.redirect(303,'/auth/login');}
  finishMfaChallenge(req,res);
  if(getSession(req))dropSession(req,res);
  await createTrackedSession(req,res,{userId:actor.userId,role:actor.role,mfaVerified:true},getPool());
  return res.redirect(303,'/auth/continue');
 }catch(error){console.error('MFA verification:',error.code||error.message);return mfaPage(req,res,503,'تعذر التحقق من الرمز حاليًا.');}
});

router.get('/continue',async(req,res,next)=>{
 const session=getSession(req);
 if(!session)return res.redirect(303,'/auth/login');
 try{
  const actor=await loadAccount(getPool(),session.userId,session.mfaVerified);
  if(!actor||actor.role!==session.role){dropSession(req,res);return res.redirect(303,'/auth/login');}
  const clinics=await clinicsFor(getPool(),actor);
  if(clinics.length===1)await setTrackedClinic(req,clinics[0].id,getPool());
  return res.redirect(303,redirectFor(actor,clinics));
 }catch(err){next(err);}
});
router.post('/logout',BODY,async(req,res)=>{
 if(!validateSessionCsrf(req))return res.status(403).type('text/plain').send('طلب خروج غير صالح. حدّث الصفحة وحاول من جديد.');
 try{await logoutTracked(req,res,getPool());return res.redirect(303,'/auth/login');}
 catch(e){console.error('[LOGOUT_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذّر إنهاء الجلسة؛ حاول مجددًا.');}
});
module.exports=router;
