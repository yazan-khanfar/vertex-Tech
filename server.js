// Smart Dental Clinic - SSR UI preview with clean URL routing.
// WARNING: These are preview pages with sample data. Authentication, authorization,
// database access and backend form handlers will be built incrementally.
'use strict';
const fs = require('node:fs');
const envPath = require('node:path').join(__dirname, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const express = require('express');
const path = require('node:path');
const pages = require('./config/page-map.json');
const app = express();

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Public role assets must be served before clinic-context guards.
// Otherwise /doctor/assets/styles.css is redirected when the doctor has no clinic.
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'deny' }));
app.use(require('./src/workspace/settings').locals);

// Enforce central session revocation before serving protected or auth routes.
app.use(async (req,res,next)=>{
  try{
    if (req.path.startsWith('/assets/') || !String(req.headers.cookie||'').includes('sdc_session=')) return next();
    await require('./src/auth/session').restoreTrackedSession(req,res,require('./db/pool').getPool());
    return next();
  } catch (error){console.error('[SESSION_STORE_UNAVAILABLE]',error.code||'UNKNOWN');return res.status(503).send('تعذّر التحقق من الجلسة حاليًا.');}
});
// Registration is implemented first; all other routes are still read-only previews.
// Unified credential verification and server-side role authorization.
app.use('/auth/password',require('./src/password-reset/router'));
app.use('/auth/change-password',require('./src/password-reset/change-router'));
app.use('/auth/security',require('./src/mfa/router'));
app.use('/account/sessions',require('./src/auth/sessions-router'));
app.use('/auth', require('./src/auth/router'));
app.get('/account/doctor-profile',(req,res)=>res.redirect(303,'/doctor/profile')); // retired duplicate UI
app.use('/account/context', require('./src/auth/context-router'));
app.use('/onboarding/doctor/clinic',require('./src/clinic-onboarding/router'));
const {guard}=require('./src/auth/guard');
app.use('/patient',guard('patient'));
// Doctor profile is account-scoped: verified doctors need it before joining a clinic.
// Use the existing original /doctor/profile template, never the extra account page.
app.get('/doctor/profile',async(req,res,next)=>{
 try{
  const {resolveSession}=require('./src/auth/guard');
  const actor=await resolveSession(req,res);
  if(!actor)return res.redirect(303,'/auth/login');
  if(actor.role!=='doctor')return res.status(403).send('هذا القسم للأطباء فقط.');
  const profile=await require('./src/account/doctor-profile-service').loadDoctorProfile(require('./db/pool').getPool(),actor.userId,actor.doctorId);
  if(!profile)return res.sendStatus(404);
  const item=pages['doctor/profile.html'];
  const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
  const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
  const {sessionCsrf,listTrackedSessions}=require('./src/auth/session');
  const {passwordError}=require('./src/password-reset/profile-destinations');
  res.set('Cache-Control','no-store');
  return res.render('doctor/profile',{
   mfaView:await require('./src/mfa/profile-page').mfaViewFor(req),
   doctorAccount:profile,clinicInvitations:await require('./src/clinic-doctors/service').invites(require('./db/pool').getPool(),actor.doctorId),clinicInvitationMessage:req.query?.clinic_invitation==='updated'?'تم تحديث طلب الانضمام بنجاح.':'',currentPage:'doctor/profile.html',role:'doctor',
   navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
   navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),
   drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
   currentUser:actor,activeClinic:res.locals.activeClinic||null,
   logoutCsrf:res.locals.logoutCsrf||'',
   passwordChangeCsrf:sessionCsrf(req),passwordChangeError:passwordError(req.query?.password_error),
   passwordChangeReference:/^[A-F0-9]{8}$/.test(String(req.query?.password_reference||''))?req.query.password_reference:'',
   accountSessions:await listTrackedSessions(require('./db/pool').getPool(),actor.userId,req.sdcSession.sessionId),
   sessionActionCsrf:sessionCsrf(req),sessionActionMessage:req.query?.sessions==='updated'?'تم تحديث الجلسات بنجاح.':''
  });
 }catch(error){next(error);}
});
// Invite decision must work even when a verified doctor has no active clinic.
app.post('/doctor/profile/membership',require('express').urlencoded({extended:false,limit:'4kb',parameterLimit:6}),async(req,res,next)=>{
 try{
  const actor=await require('./src/auth/guard').resolveSession(req,res);
  if(!actor)return res.redirect(303,'/auth/login');
  if(actor.role!=='doctor')return res.sendStatus(403);
  if(!require('./src/auth/session').validateSessionCsrf(req))return res.sendStatus(403);
  const r=await require('./src/clinic-doctors/service').decide(require('./db/pool').getPool(),actor.doctorId,actor.userId,req.body.clinic_id,req.body.action);
  if(r.status!=='ok')return res.status(409).send('تعذّر معالجة الدعوة. ربما تم إلغاؤها؛ حدّث صفحة الملف الشخصي.');
  return res.redirect(303,'/doctor/profile?clinic_invitation=updated#clinic-invitations');
 }catch(e){next(e);}
});
app.use('/doctor',guard('doctor'));
app.use('/clinic',guard('clinic'));
app.use(require('./src/workspace/notifications').locals);
// All original clinic header variants share the same live user notifications.
app.use('/clinic',require('./src/clinic-notifications-router'));
const appointmentRoutes=require('./src/appointments/router');
app.use('/patient',appointmentRoutes.patientRouter);
app.use('/doctor',appointmentRoutes.doctorRouter);
app.use('/clinic',appointmentRoutes.clinicRouter);
// Daily operations reuse clinic/operations and doctor/visit; no duplicate UI pages.
const dailyRoutes=require('./src/daily-operations/router');
app.use('/clinic',dailyRoutes.clinicRouter);
app.use('/doctor',dailyRoutes.doctorRouter);
// Doctor batch 1: real dashboard, scoped patient files and follow-up read models.
app.use('/doctor',require('./src/doctor-workspace/router'));
// v26 clinical forms and authentic visit reports in existing original templates.
app.use('/doctor',require('./src/doctor-workspace/clinical-router'));
app.use('/staff',guard('staff'),dailyRoutes.staffRouter);
app.use('/staff',appointmentRoutes.staffRouter);
app.use('/clinic',require('./src/clinic-dashboard/router'));
app.use('/clinic',require('./src/clinic-account-settings/router'));
app.use('/clinic',require('./src/clinic-settings-router'));
app.use('/clinic',require('./src/clinic-documents-router'));
app.use('/clinic',require('./src/clinic-patients/router'));
app.use('/clinic',require('./src/clinic-staff/router'));
// Read-only clinic clinical summaries in the original page templates.
app.use('/clinic',require('./src/clinic-clinical-router'));
// v21: original inventory, invoice and settlement pages bound to clinic-scoped PostgreSQL records.
app.use('/clinic',require('./src/clinic-finance-inventory-router'));
app.use('/clinic',require('./src/clinic-remaining-router'));
app.use('/staff/choose-clinic',guard('staff'),require('./src/auth/context-router'));
app.use('/staff',guard('staff'));
// Doctor onboarding after login is visible only to a verified doctor. The
// pending / rejected license status pages remain public information pages.
app.use('/onboarding/doctor', async(req,res,next)=>{
  if(['/verification-pending','/license-status','/approval-pending'].includes(req.path))return next();
  try{
    const {resolveSession}=require('./src/auth/guard');
    const actor=await resolveSession(req,res);
    if(!actor)return res.redirect(303,'/auth/login');
    if(actor.role!=='doctor')return res.status(403).send('هذا القسم للأطباء المعتمدين فقط.');
    return next();
  }catch(err){return next(err);}
});
app.use('/auth/register/patient', require('./src/registration/router'));
app.use('/auth/register/doctor', require('./src/doctor-registration/router'));
// All /admin pages now require an authenticated Super Admin.
app.use('/admin', require('./src/admin-review/router'));

// The allowlist maps stable public URLs to actual EJS templates.
// Never render a template using arbitrary user-provided paths.
const cleanRoutes = Object.create(null);
for (const legacyKey of Object.keys(pages)) {
  if (!legacyKey.endsWith('.html')) throw new Error(`Unexpected page-map key: ${legacyKey}`);
  const slug = legacyKey.slice(0, -'.html'.length);
  if (Object.prototype.hasOwnProperty.call(cleanRoutes, slug)) {
    throw new Error(`Duplicate clean route: ${slug}`);
  }
  cleanRoutes[slug] = legacyKey;
}


// Old bookmarks continue to work, but canonical navigation uses clean URLs.
// Redirect only known pages (never redirect arbitrary .html paths).
app.get(/^\/.*\.html$/, (req, res, next) => {
  const legacyKey = req.path.slice(1);
  if (!Object.prototype.hasOwnProperty.call(pages, legacyKey)) return next();
  const cleanPath = '/' + legacyKey.slice(0, -'.html'.length);
  const queryIndex = req.originalUrl.indexOf('?');
  const queryString = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
  return res.redirect(301, cleanPath + queryString);
});

async function renderPage(req, res, next) {
  // /index is the clean counterpart of /index.html; / is an additional home alias.
  const slug = req.path === '/' ? 'index' : req.path.slice(1);
  if (!Object.prototype.hasOwnProperty.call(cleanRoutes, slug)) return next();
  const key = cleanRoutes[slug];
  const item = pages[key];
  const css = (kind, href) => {
    const classes = item[kind + 'ActiveClasses'][href];
    return classes ? ' ' + classes : '';
  };
  const aria = (kind, href) => item[kind + 'Aria'][href] === 'page' ? ' aria-current="page"' : '';
  const showSessions=new Set(['patient/profile','doctor/profile','staff/profile','clinic/account-settings','admin/settings']);
  let accountSessions=[];
  if(showSessions.has(slug) && res.locals?.currentUser && req.sdcSession){
    try {accountSessions=await require('./src/auth/session').listTrackedSessions(require('./db/pool').getPool(),
      req.sdcActor.userId,req.sdcSession.sessionId);}
    catch(error){return next(error);}
    res.set('Cache-Control','no-store');
  }
  const mfaPages=new Set(['patient/profile','doctor/profile','staff/profile','clinic/account-settings','admin/settings']);
  const mfaView=mfaPages.has(slug)&&req.sdcActor?await require('./src/mfa/profile-page').mfaViewFor(req):null;
  res.render(item.view, {
    mfaView,accountSessions,sessionActionCsrf:req.sdcSession?.csrf||'',
    sessionActionMessage:req.query?.sessions==='updated'?'تم تحديث الجلسات بنجاح.':'',
    currentPage: key,
    adminCsrfToken: item.role === 'admin' ? require('./src/security/csrf').issueCsrf(res,'admin') : '',
    pendingClinicCount: res.locals?.adminPendingClinics || 0,
    logoutCsrf: res.locals?.logoutCsrf || '',
    currentUser: res.locals?.currentUser || null,
    passwordChangeCsrf: require('./src/auth/session').sessionCsrf(req),
    passwordChangeError: require('./src/password-reset/profile-destinations').passwordError(req.query?.password_error),
    passwordChangeReference: /^[A-F0-9]{8}$/.test(String(req.query?.password_reference||'')) ? req.query.password_reference : '',
    activeClinic: res.locals?.activeClinic || null,
    staffPermissions: res.locals?.staffPermissions || '',
    staffClinicRole: res.locals?.staffClinicRole || '',
    hasStaffPermission: code => require('./src/staff-access/policy').can(res.locals?.staffPermissions,code),
    role: item.role,
    navVariant: item.navVariant,
    drawerVariant: item.drawerVariant,
    footerVariant: item.footerVariant,
    navActiveClass: href => css('nav', href),
    navAriaCurrent: href => aria('nav', href),
    drawerActiveClass: href => css('drawer', href),
    drawerAriaCurrent: href => aria('drawer', href),
  }, (error, html) => {
    if (error) return next(error);
    res.type('html').send(html);
  });
}
require('./src/workspace/router').attach(app);
app.get(['/', /^\/(?:.+\/)?[^/]+$/], renderPage);
app.use((req, res) => res.status(404).type('text/plain').send('Page not found'));
app.use((err, req, res, next) => {
  // Body-parser errors are request errors, not EJS/SSR failures.
  // Keep detailed diagnostics server-side without logging form contents or tokens.
  if (err.type === 'parameters.too.many' || err.type === 'entity.too.large') {
    console.warn('[REQUEST_BODY_REJECTED]', req.method, req.path, err.type);
    if (res.headersSent) return next(err);
    return res.status(413).type('text/plain').send('تعذّر معالجة الطلب: بيانات النموذج أكبر من الحد المسموح.');
  }
  if (err.type === 'entity.parse.failed') {
    console.warn('[INVALID_REQUEST_BODY]', req.method, req.path);
    if (res.headersSent) return next(err);
    return res.status(400).type('text/plain').send('بيانات النموذج غير صالحة.');
  }
  console.error('SSR render error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).type('text/plain').send('Page rendering error');
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
if (require.main === module) {
  app.listen(port, () => console.log(`Smart Dental Clinic preview: http://localhost:${port}`));
}
module.exports = app;
