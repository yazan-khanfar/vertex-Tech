'use strict';
const {getPool}=require('../../db/pool');
const {getSession,dropSession,sessionCsrf,validateSessionCsrf,setTrackedClinic}=require('./session');
const {loadAccount,clinicsFor}=require('./service');
const {accessFor,can}=require('../staff-access/policy');
async function resolveSession(req,res){
 const session=getSession(req);
 if(!session)return null;
 const actor=await loadAccount(getPool(),session.userId,session.mfaVerified);
 if(!actor||actor.role!==session.role){dropSession(req,res);return null;}
 const clinics=await clinicsFor(getPool(),actor);
 if(session.clinicId&&!clinics.some(c=>c.id===session.clinicId))session.clinicId=null;
 req.sdcSession=session;req.sdcActor=actor;req.sdcClinics=clinics;
 if(actor.role==='admin')req.adminUserId=actor.userId;
 res.locals.logoutCsrf=sessionCsrf(req);
 res.locals.currentUser=actor;
 res.locals.activeClinic=clinics.find(c=>c.id===session.clinicId)||null;
 return actor;
}
function guard(kind){
 return async(req,res,next)=>{
  try{
   const actor=await resolveSession(req,res);
   if(!actor){if(req.method==='GET')return res.redirect(303,'/auth/login');return res.status(401).send('يجب تسجيل الدخول أولًا.');}
   if(kind==='admin'&&actor.role!=='admin')return res.status(403).send('هذه الصفحة للمشرف العام فقط.');
   if(kind==='patient'&&actor.role!=='patient')return res.status(403).send('هذه الصفحة للمريض فقط.');
   if(kind==='doctor'&&actor.role!=='doctor')return res.status(403).send('هذه الصفحة للطبيب فقط.');
   if(kind==='staff'&&actor.role!=='staff')return res.status(403).send('هذه الصفحة لموظف العيادة فقط.');
   if(kind==='clinic'&&(actor.role!=='doctor'||!req.sdcClinics.some(c=>c.manager)))return res.status(403).send('هذه الصفحة لمدير العيادة فقط.');
   if(kind==='staff'){
     const rule=accessFor(req.method,req.originalUrl.split('?')[0].startsWith('/staff/choose-clinic')?'/choose-clinic':req.path);
     if(rule.deny)return res.status(403).send('هذه العملية غير متاحة لحساب الموظف.');
     res.locals.staffPermissions='';
     res.locals.staffClinicRole='موظف العيادة';
     if(req.sdcSession.clinicId){
       const permissions=await getPool().query(`SELECT p."Permission_Code",r."Role_Name" FROM sdc."STAFF_AT" s
         JOIN sdc."ROLE" r ON r."Role_ID"=s."Role_ID"
         LEFT JOIN sdc."STAFF_PERMISSIONS" p ON p."User_ID"=s."User_ID" AND p."Clinic_ID"=s."Clinic_ID"
         WHERE s."User_ID"=$1::bigint AND s."Clinic_ID"=$2::bigint AND s."Membership_Status"='active'`,
         [actor.userId,req.sdcSession.clinicId]);
       // Do not allow a suspended or stale membership to render a page.
       if(!permissions.rows.length){
         return req.method==='GET'?res.redirect(303,'/staff/choose-clinic'):res.sendStatus(403);
       }
       res.locals.staffPermissions=[...new Set(permissions.rows.map(v=>v.Permission_Code).filter(Boolean))].join(' ');
       res.locals.staffClinicRole=permissions.rows[0].Role_Name||'موظف العيادة';
     }
     if(!req.sdcSession.clinicId&&!req.path.startsWith('/choose-clinic')){
       return req.method==='GET'?res.redirect(303,'/staff/choose-clinic'):res.sendStatus(403);
     }
     if(rule.permission&&!can(res.locals.staffPermissions,rule.permission)){
       return res.status(403).send('لا تملك صلاحية الوصول لهذا القسم في العيادة المحددة.');
     }
   }
   if(['doctor','staff','clinic'].includes(kind)){
    const clinic=req.sdcClinics.find(c=>c.id===req.sdcSession.clinicId);
    if(!clinic || kind==='clinic'&&!clinic.manager){
     // Do not serve sensitive sample pages with fabricated clinic context.
     const path=kind==='staff'?'/staff/choose-clinic':'/account/context';
     if(!req.originalUrl.startsWith('/staff/choose-clinic'))return res.redirect(303,path);
    }
   }
   return next();
  }catch(err){console.error('Authorization unavailable:',err.code||err.message);return res.status(503).send('تعذّر التحقق من صلاحياتك حاليًا.');}
 };
}
function contextPage(res,clinics,csrf,error='',mode='doctor'){
 res.set('Cache-Control','no-store');
 return res.render('account/context',{clinics,csrfToken:csrf,contextError:error,mode});
}
async function chooseContextGet(req,res){
 const actor=await resolveSession(req,res);
 if(!actor)return res.redirect(303,'/auth/login');
 if(!['doctor','staff'].includes(actor.role))return res.status(403).send('لا توجد عيادات مرتبطة بهذا الحساب.');
 return contextPage(res,req.sdcClinics,sessionCsrf(req),'',actor.role);
}
async function chooseContextPost(req,res){
 const actor=await resolveSession(req,res);
 if(!actor)return res.status(401).send('سجّل الدخول أولًا.');
 if(!validateSessionCsrf(req))return res.status(403).send('نموذج غير صالح. ارجع وحدّث الصفحة.');
 const id=String(req.body?.clinic_id||'');
 const selected=req.sdcClinics.find(c=>c.id===id);
 if(!selected)return res.status(403).send('لا تملك عضوية فعّالة في هذه العيادة.');
 const space=String(req.body?.space||actor.role);
 if(actor.role==='doctor'&&!['doctor','clinic'].includes(space))return res.status(403).send('صلاحيات غير صالحة.');
 if(space==='clinic'&&!selected.manager)return res.status(403).send('إدارة العيادة متاحة للمدير فقط.');
 if(actor.role==='staff'&&space!=='staff')return res.status(403).send('صلاحيات غير صالحة.');
 await setTrackedClinic(req,id,getPool());
 return res.redirect(303,space==='clinic'?'/clinic/index':space==='doctor'?'/doctor/index':'/staff/index');
}
module.exports={resolveSession,guard,chooseContextGet,chooseContextPost};
