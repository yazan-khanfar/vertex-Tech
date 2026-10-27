'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const {resolveSession}=require('../auth/guard');
const {validateSessionCsrf,revokeOtherTrackedSessions}=require('../auth/session');
const {verifyPassword}=require('../security/password');
const {profilePath}=require('../password-reset/profile-destinations');
const {mfaState,enableMfa,disableMfa}=require('./service');
const {newSecret,matchTotp}=require('./crypto');
const {put}=require('./one-time-feedback');
const router=express.Router();
const BODY=express.urlencoded({extended:false,limit:'4kb',parameterLimit:6});
const attempts=new Map();
function allowed(key){const now=Date.now();if(attempts.size>1000)for(const [k,v] of attempts)if(now-v.start>15*60*1000)attempts.delete(k);const prev=attempts.get(key);const next=prev&&now-prev.start<15*60*1000?{start:prev.start,count:prev.count+1}:{start:now,count:1};attempts.set(key,next);return next.count<=12;}
async function auth(req,res,next){try{if(!await resolveSession(req,res))return res.redirect(303,'/auth/login');next();}catch(e){next(e);}}
router.use(auth);
function page(req,res,{message='',error='',codes=null}={}){
 // All response HTML and relative CSS/JS paths belong to the canonical
 // profile/settings route, never the POST action URL.
 put(req,{message,error,codes});
 const dest=profilePath(req.sdcActor,req.body?.profile_scope,req.sdcSession,req.sdcClinics);
 res.set('Cache-Control','no-store');
 return res.redirect(303,dest+'#sdc-mfa');
}
router.use(async(req,res,next)=>{try{req.mfaState=await mfaState(getPool(),req.sdcActor.userId);if(!req.mfaState)return res.status(403).send('الحساب غير موجود.');next();}catch(e){next(e);}});
router.get('/',(req,res)=>res.redirect(303,profilePath(req.sdcActor,'',req.sdcSession,req.sdcClinics)+'#sdc-mfa'));
router.post('/start',BODY,async(req,res,next)=>{
 if(!validateSessionCsrf(req))return page(req,res,{status:403,error:'انتهت صلاحية النموذج.'});
 if(req.mfaState.Two_Factor_Enabled===true)return page(req,res,{error:'التحقق الثنائي مفعّل بالفعل.'});
 if(!allowed(`${req.ip}:${req.sdcActor.userId}:start`))return page(req,res,{status:429,error:'محاولات كثيرة. حاول لاحقًا.'});
 if(typeof req.body.password!=='string'||!await verifyPassword(req.body.password,req.mfaState.Password_Hash))return page(req,res,{status:401,error:'كلمة المرور غير صحيحة.'});
 // Never write an unconfirmed authenticator secret to the database.
 req.sdcSession.mfaEnrollSecret=newSecret();req.sdcSession.mfaEnrollIssuedAt=Date.now();
 return page(req,res,{message:'أضف المفتاح في تطبيق المصادقة، ثم اكتب رمزًا جديدًا للتفعيل.'});
});
router.post('/confirm',BODY,async(req,res,next)=>{
 if(!validateSessionCsrf(req))return page(req,res,{status:403,error:'انتهت صلاحية النموذج.'});
 if(req.mfaState.Two_Factor_Enabled)return page(req,res,{error:'التحقق مفعل بالفعل.'});
 if(!allowed(`${req.ip}:${req.sdcActor.userId}:confirm`))return page(req,res,{status:429,error:'محاولات كثيرة. حاول لاحقًا.'});
 const secret=req.sdcSession.mfaEnrollSecret;
 if(!secret||Date.now()-req.sdcSession.mfaEnrollIssuedAt>10*60*1000){delete req.sdcSession.mfaEnrollSecret;return page(req,res,{error:'انتهت صلاحية الإعداد. ابدأ مجددًا.'});}
 if(matchTotp(secret,req.body?.code)===null)return page(req,res,{status:422,error:'رمز التحقق غير صحيح. تأكد من ضبط وقت الهاتف.'});
 try{
  const outcome=await enableMfa(getPool(),req.sdcActor.userId,secret);
  if(!outcome.ok)return page(req,res,{error:'التحقق الثنائي مفعّل بالفعل.'});
  delete req.sdcSession.mfaEnrollSecret;delete req.sdcSession.mfaEnrollIssuedAt;
  req.mfaState.Two_Factor_Enabled=true;
  req.sdcSession.mfaVerified=true;
  await revokeOtherTrackedSessions(getPool(),req.sdcActor.userId,req.sdcSession);
  // Show raw recovery codes only once, never store them in the session, logs, or plaintext DB.
  return page(req,res,{message:'تم تفعيل التحقق الثنائي بنجاح. احفظ رموز الاسترداد الآن في مكان آمن.',codes:outcome.codes});
 }catch(e){next(e);}
});
router.post('/cancel',BODY,(req,res)=>{
 if(!validateSessionCsrf(req))return page(req,res,{status:403,error:'انتهت صلاحية النموذج.'});
 delete req.sdcSession.mfaEnrollSecret;delete req.sdcSession.mfaEnrollIssuedAt;
 return page(req,res);
});
router.post('/disable',BODY,async(req,res,next)=>{
 if(!validateSessionCsrf(req))return page(req,res,{status:403,error:'انتهت صلاحية النموذج.'});
 if(req.mfaState.Two_Factor_Enabled!==true)return page(req,res,{error:'التحقق غير مفعّل.'});
 if(!allowed(`${req.ip}:${req.sdcActor.userId}:disable`))return page(req,res,{status:429,error:'محاولات كثيرة. حاول لاحقًا.'});
 try{
  const success=await disableMfa(getPool(),req.sdcActor.userId,req.body.password,req.body.code);
  if(!success)return page(req,res,{status:401,error:'كلمة المرور أو رمز التحقق غير صحيح.'});
  req.sdcSession.mfaVerified=false;
  req.mfaState.Two_Factor_Enabled=false;
  await revokeOtherTrackedSessions(getPool(),req.sdcActor.userId,req.sdcSession);
  return page(req,res,{message:'تم إيقاف التحقق الثنائي، وإبطال الجلسات الأخرى.'});
 }catch(e){next(e);}
});
module.exports=router;
