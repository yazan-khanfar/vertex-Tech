'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const {issueCsrf,validateCsrf}=require('../security/csrf');
const {requestReset,isValidReset,resetPassword,validToken,validPassword}=require('./service');
const {config}=require('./delivery');
const router=express.Router();
const body=express.urlencoded({extended:false,limit:'8kb',parameterLimit:6});
const attempts=new Map();
function allowed(req,action,max=6){
  const now=Date.now();if(attempts.size>1000)for(const [key,v] of attempts)if(v.at+15*60*1000<now)attempts.delete(key);
  const key=action+':'+String(req.ip||'unknown');const v=attempts.get(key);
  const entry=v&&v.at+15*60*1000>now?v:{at:now,n:0};entry.n++;attempts.set(key,entry);return entry.n<=max;
}
function noStore(res){res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');}
function forgotPage(res,{error='',status=200}={}){
  noStore(res);return res.status(status).render('auth/password/forgot',{csrfToken:issueCsrf(res,'login'),error});
}
function resetPage(res,token,{error='',status=200,valid=false}={}){
  noStore(res);return res.status(status).render('auth/password/reset',{csrfToken:issueCsrf(res,'login'),resetToken:valid?token:'',error,valid});
}
router.get('/forgot',(_req,res)=>forgotPage(res));
router.post('/forgot',body,async(req,res)=>{
  if(!validateCsrf(req,'login'))return forgotPage(res,{status:403,error:'انتهت صلاحية نموذج الاستعادة. حاول من جديد.'});
  if(!allowed(req,'forgot'))return forgotPage(res,{status:429,error:'محاولات كثيرة. حاول بعد 15 دقيقة.'});
  try{
    config(); // Uniform 503 if delivery is not configured, regardless of account existence.
    await requestReset(getPool(),req.body?.email);
    return res.redirect(303,'/auth/password/reset-link-sent');
  }catch(error){
    console.error('Password recovery request:',error.code||error.message);
    if(error.code==='MAIL_NOT_CONFIGURED')return forgotPage(res,{status:503,error:'خدمة البريد غير مهيّأة بعد. أضف إعدادات الإرسال إلى ملف .env.'});
    // Do not expose whether the email exists when a provider is unavailable.
    return res.redirect(303,'/auth/password/reset-link-sent');
  }
});
router.get('/reset-link-sent',(req,res)=>{noStore(res);res.render('auth/password/reset-link-sent',{completed:req.query?.done==='1'});});
router.get('/reset',async(req,res)=>{
  const token=typeof req.query?.token==='string'?req.query.token:'';
  try{
    const valid=await isValidReset(getPool(),token);
    return resetPage(res,token,{valid,error:valid?'':'رابط الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',status:valid?200:400});
  }catch(error){console.error('Reset link validation:',error.code||error.message);return resetPage(res,'',{status:503,error:'تعذّر التحقق من رابط الاستعادة حاليًا.'});}
});
router.post('/reset',body,async(req,res)=>{
  const token=req.body?.token;
  if(!validateCsrf(req,'login'))return resetPage(res,token,{status:403,error:'انتهت صلاحية النموذج. افتح رابط الاستعادة من جديد.',valid:false});
  if(!allowed(req,'reset',10))return resetPage(res,'',{status:429,error:'محاولات كثيرة. حاول لاحقًا.'});
  const pass=req.body?.password;
  if(!validToken(token)||!validPassword(pass)||pass!==req.body?.password_confirmation){
    return resetPage(res,token,{valid:validToken(token),status:422,error:'استخدم كلمة مرور قوية (14 حرفًا على الأقل، أحرف ورقم ورمز) مع تأكيد مطابق.'});
  }
  try{
    if(!await resetPassword(getPool(),token,pass))return resetPage(res,'',{status:400,error:'الرابط مستخدم أو منتهي أو كلمة المرور هي السابقة. اطلب رابطًا جديدًا.'});
    return res.redirect(303,'/auth/password/reset-link-sent?done=1');
  }catch(error){console.error('Password reset:',error.code||error.message);return resetPage(res,'',{status:503,error:'تعذّر إعادة تعيين كلمة المرور حاليًا.'});}
});
module.exports=router;
