'use strict';
const express = require('express');
const { issueCsrf, validateCsrf } = require('../security/csrf');
const { limitPatientRegistration } = require('../security/rateLimit');
const { parsePatientForm } = require('./validate');
const { registerPatient } = require('./service');
const { getPool } = require('../../db/pool');
const router = express.Router();
function showForm(res, status = 200, registerError = '', formValues = {}) {
  return res.status(status).render('auth/register/patient', { csrfToken: issueCsrf(res), registerError, formValues });
}
router.get('/', (req, res) => { res.setHeader('Cache-Control','no-store'); return showForm(res); });
router.post('/', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 25 }), limitPatientRegistration, async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  // Keep submitted non-secret details only, not passwords or consent decisions.
  const formValues = {};
  for (const key of ['first_name','last_name','date_of_birth','gender','phone','email']) {
    if (typeof req.body?.[key] === 'string') formValues[key] = req.body[key].slice(0,254);
  }
  if (!validateCsrf(req)) return showForm(res,403,'انتهت صلاحية نموذج التسجيل. أعد المحاولة من جديد.',formValues);
  const validation = parsePatientForm(req.body);
  if (validation.error) return showForm(res,422,validation.error,formValues);
  try {
    await registerPatient(getPool(), validation.data, process.env.POLICY_VERSION);
    return res.redirect(303,'/auth/register/success?role=patient');
  } catch (err) {
    if (err.code === '23505') return showForm(res,409,'البريد الإلكتروني مستخدم بالفعل. جرّب بريدًا آخر أو سجّل الدخول.',formValues);
    if (err.code === 'ROLE_MISSING' || err.code === 'DATABASE_NOT_CONFIGURED') {
      console.error('Patient registration setup:', err.message);
      return showForm(res,503,'التسجيل غير مهيأ بعد على الخادم. راجع إعدادات قاعدة البيانات.',formValues);
    }
    console.error('Patient registration failed:', err.code || err.message);
    return showForm(res,503,'تعذّر إنشاء الحساب الآن. أعد المحاولة لاحقًا.',formValues);
  }
});
module.exports = router;
