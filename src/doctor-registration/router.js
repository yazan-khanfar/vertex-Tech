'use strict';
const express=require('express');
const {issueCsrf,validateCsrf}=require('../security/csrf');
const {limitDoctorRegistration}=require('../security/rateLimit');
const {parseDoctorForm}=require('./validate');
const {registerDoctor}=require('./service');
const {getPool}=require('../../db/pool');
const router=express.Router();
async function showForm(res,status=200,registerError='',formValues={}) {
  let specialtyChoices=[];
  try{specialtyChoices=(await getPool().query('SELECT "Specialty_ID"::text id,"Name_AR" name FROM sdc."SPECIALTY" WHERE "Is_Active" ORDER BY "Name_AR"')).rows;}
  catch(e){console.error('[DOCTOR_SPECIALTIES]',e.code||'UNAVAILABLE');if(status===200)status=503;registerError=registerError||'تعذر تحميل قائمة التخصصات حاليًا.';}
  return res.status(status).render('auth/register/doctor', {
    csrfToken:issueCsrf(res,'doctor'),registerError,formValues,specialtyChoices
  });
}
router.get('/',(req,res)=>{res.setHeader('Cache-Control','no-store');return showForm(res);});
router.post('/',express.urlencoded({extended:false,limit:'16kb',parameterLimit:30}),limitDoctorRegistration,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const formValues={};
  for(const name of ['first_name','last_name','phone','license_number','email']) {
    if(typeof req.body?.[name]==='string') formValues[name]=req.body[name].slice(0,254);
  }
  const submitted=req.body?.['specialty_ids[]'];
  if(Array.isArray(submitted)) formValues.specialties=submitted.filter(x=>typeof x==='string').slice(0,6);
  else if(typeof submitted==='string') formValues.specialties=[submitted];
  if(!validateCsrf(req,'doctor')) return showForm(res,403,'انتهت صلاحية نموذج التسجيل. أعد المحاولة من جديد.',formValues);
  const parsed=parseDoctorForm(req.body);
  if(parsed.error) return showForm(res,422,parsed.error,formValues);
  try {
    await registerDoctor(getPool(),parsed.data,process.env.POLICY_VERSION);
    return res.redirect(303,'/onboarding/doctor/verification-pending?registration=created');
  } catch(err) {
    if(err.code==='23505') return showForm(res,409,'البريد الإلكتروني أو رقم الترخيص مستخدم بالفعل. راجع البيانات.',formValues);
    if(['ROLE_MISSING','SPECIALTY_MISSING','DATABASE_NOT_CONFIGURED'].includes(err.code)) {
      console.error('Doctor registration setup:',err.message);
      return showForm(res,503,'التسجيل غير مهيأ بعد على الخادم. نفذ إعداد دور الطبيب والتخصصات.',formValues);
    }
    console.error('Doctor registration failed:',err.code||err.message);
    return showForm(res,503,'تعذّر إنشاء حساب الطبيب الآن. أعد المحاولة لاحقًا.',formValues);
  }
});
module.exports=router;
