'use strict';
const express=require('express');
const {getPool}=require('../db/pool');
const {sessionCsrf,validateSessionCsrf}=require('./auth/session');
const pages=require('../config/page-map.json');
const svc=require('./clinic-settings-service');
const router=express.Router();
// Multipart uploads are handled independently by multer.
router.use(['/profile','/services'],express.urlencoded({extended:false,limit:'50kb',parameterLimit:100}));
function locals(name,req,res,data){
 const item=pages[`clinic/${name}.html`];
 const css=(kind,href)=>item[kind+'ActiveClasses'][href]?' '+item[kind+'ActiveClasses'][href]:'';
 const aria=(kind,href)=>item[kind+'Aria'][href]==='page'?' aria-current="page"':'';
 return {currentPage:`clinic/${name}.html`,role:'clinic',navVariant:item.navVariant,drawerVariant:item.drawerVariant,footerVariant:item.footerVariant,
  navActiveClass:href=>css('nav',href),navAriaCurrent:href=>aria('nav',href),drawerActiveClass:href=>css('drawer',href),drawerAriaCurrent:href=>aria('drawer',href),
  currentUser:res.locals.currentUser||null,activeClinic:res.locals.activeClinic||null,logoutCsrf:res.locals.logoutCsrf||'',csrfToken:sessionCsrf(req),...data};
}
function idOf(req,res){const id=svc.clinicId(req);if(!id)res.status(403).send('لا تملك صلاحية إدارة العيادة المحددة.');return id;}
router.get('/profile',async(req,res,next)=>{const id=idOf(req,res);if(!id)return;try{
 const data=await svc.readProfile(getPool(),id);if(!data)return res.sendStatus(404);
 const msg=req.query.saved==='1'?'تم حفظ التعديلات في قاعدة البيانات بنجاح.':'';
 res.set('Cache-Control','no-store');return res.render('clinic/profile',locals('profile',req,res,{...data,saveMessage:msg,formError:''}));
 }catch(e){next(e);}});
router.post('/profile',async(req,res,next)=>{const id=idOf(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.status(403).send('نموذج حماية غير صالح. حدّث الصفحة.');
 const type=String(req.body?.action||'');if(!['details','hours','exceptions','booking'].includes(type))return res.sendStatus(422);
 try{
  const result=await svc.change(getPool(),id,req.sdcActor.userId,type,req.body);
  if(result.status==='ok')return res.redirect(303,'/clinic/profile?saved=1#'+({hours:'settings',exceptions:'sdcClinicExceptions',booking:'booking',details:'basic'}[type]));
  const messages={
   invalid:'البيانات غير صالحة. راجع الحقول المطلوبة، الأيام وساعات العمل، أو التواريخ وفترات الاستثناء.',
   bookings_conflict:'لا يمكن تطبيق التغيير لأن هناك موعدًا مؤكدًا أو بانتظار الموافقة سيصبح خارج ساعات العيادة. راجع المواعيد أولًا، ثم أعد حفظ الدوام.',
   ai_pending:'لا يمكن إيقاف الحجز الإلكتروني حاليًا لوجود مواعيد من مساعد الحجز الذكي لم تُحسم بعد. راجعها أولًا.',
   not_found:'العيادة المحددة غير متاحة للإدارة.'
  };
  const data=await svc.readProfile(getPool(),id);
  if(!data)return res.sendStatus(404);
  return res.status(result.status==='invalid'?422:409).render('clinic/profile',locals('profile',req,res,{...data,saveMessage:'',formError:messages[result.status]||'تعذّر حفظ التعديل.'}));
 }catch(e){
  console.error('[CLINIC_SETTINGS_FAILED]',type,e.code||'UNKNOWN');
  // The deferred PostgreSQL integrity constraints may detect a concurrent
  // conflict after the preflight. Never expose SQL details to the browser.
  const conflict=e.code==='23514'||e.code==='23P01'||e.code==='23505';
  const data=await svc.readProfile(getPool(),id).catch(()=>null);
  if(data)return res.status(conflict?409:503).render('clinic/profile',locals('profile',req,res,{...data,saveMessage:'',formError:conflict?'لم تُحفظ التغييرات بسبب تعارض مع موعد أو قيد من قاعدة البيانات. بقيت بيانات العيادة السابقة محفوظة.':'تعذّر حفظ التعديلات حاليًا. حاول مجددًا.'}));
  return res.status(503).send('تعذّر تحميل إعدادات العيادة حاليًا.');
 }
});
router.get('/services',async(req,res,next)=>{const id=idOf(req,res);if(!id)return;try{
 const data=await svc.readServices(getPool(),id);res.set('Cache-Control','no-store');return res.render('clinic/services',locals('services',req,res,{...data,saveMessage:req.query.saved==='1'?'تم حفظ الخدمة.':'',formError:''}));
 }catch(e){next(e);}});
router.post('/services',async(req,res,next)=>{const id=idOf(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.status(403).send('رمز الحماية غير صالح.');
 try{
  const result=await svc.saveService(getPool(),id,req.sdcActor.userId,req.body);
  if(result.status==='ok')return res.redirect(303,'/clinic/services?saved=1');
  const data=await svc.readServices(getPool(),id);
  const msgs={invalid:'راجع اختيار الخدمة والسعر والمدة.',duplicate:'هذه الخدمة موجودة في الكتالوج؛ اخترها بدل تكرارها.',doctors:'يمكن إسناد الخدمة فقط لأطباء مرتبطين بالعيادة.',forbidden:'لا تملك صلاحية تعديل العيادة.'};
  return res.status(422).render('clinic/services',locals('services',req,res,{...data,saveMessage:'',formError:msgs[result.status]||'تعذّر الحفظ.'}));
 }catch(e){console.error('[CLINIC_SERVICE_FAILED]',e.code||'UNKNOWN');return res.status(e.code==='23503'?409:503).send(e.code==='23503'?'لا يمكن إلغاء إسناد هذه الخدمة للطبيب لأنها مستخدمة في حجوزات قائمة.':'تعذّر حفظ الخدمة. راجع سجل التشغيل.');}
});
const multer=require('multer');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const docService=require('./clinic-onboarding/service');
const logoUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1,fields:3,parts:5}}).single('logo');
router.post('/logo',(req,res,next)=>logoUpload(req,res,error=>{if(error)return res.status(422).send('الملف يتجاوز 2MB أو غير صالح.');next();}),async(req,res)=>{
 const id=idOf(req,res);if(!id)return;
 if(!validateSessionCsrf(req))return res.status(403).send('رمز الحماية غير صالح.');
 const type=docService.docType(req.file?.buffer);
 if(!type||!['.png','.jpg'].includes(type.extension)||req.file.size>2*1024*1024)return res.status(422).send('اختر شعار JPG أو PNG لا يتجاوز 2MB.');
 const filename=crypto.randomUUID()+type.extension;
 const example=docService.documentPath(filename);if(!example)return res.status(500).send('تعذر اختيار مسار حفظ الملف.');
 const client=await getPool().connect();let written=false;
 try{
  await fs.mkdir(path.dirname(example),{recursive:true,mode:0o700});await fs.writeFile(example,req.file.buffer,{flag:'wx',mode:0o600});written=true;
  await client.query('BEGIN');await client.query("SELECT set_config('sdc.user_id',$1,true)",[req.sdcActor.userId]);
  const lock=await client.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active' FOR UPDATE`,[id]);
  if(!lock.rowCount){await client.query('ROLLBACK');await fs.unlink(example);return res.sendStatus(403);}
  const max=await client.query(`SELECT COALESCE(MAX("Version_Number"),0)+1 AS v FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1::bigint AND "Document_Type"='clinic_logo'`,[id]);
  await client.query(`UPDATE sdc."CLINIC_DOCUMENTS" SET "Is_Current"=false WHERE "Clinic_ID"=$1::bigint AND "Document_Type"='clinic_logo' AND "Is_Current"`,[id]);
  await client.query(`INSERT INTO sdc."CLINIC_DOCUMENTS"("Document_Type","File_Reference","File_Name","Version_Number","Uploaded_At","Review_Status","Is_Current","Clinic_ID") VALUES('clinic_logo',$1::varchar(512),$2::varchar(512),$3::integer,LOCALTIMESTAMP,'approved',true,$4::bigint)`,[filename,String(req.file.originalname||'clinic-logo').slice(0,180),Number(max.rows[0].v),id]);
  await client.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,'clinic.logo.updated','Clinic',$1::varchar(512),'تحديث شعار العيادة',$2::bigint)`,[id,req.sdcActor.userId]);
  await client.query('COMMIT');return res.redirect(303,'/clinic/profile?saved=1#sdcClinicFileVersions');
 }catch(e){try{await client.query('ROLLBACK')}catch{};if(written)await fs.unlink(example).catch(()=>{});console.error('[CLINIC_LOGO_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذر حفظ الشعار حاليًا.');}finally{client.release();}
});
router.get('/logo/current',async(req,res,next)=>{const id=idOf(req,res);if(!id)return;
 try{const r=await getPool().query(`SELECT "File_Reference" FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1::bigint AND "Document_Type"='clinic_logo' AND "Is_Current"=true`,[id]);if(!r.rowCount)return res.sendStatus(404);
  const file=docService.documentPath(r.rows[0].File_Reference);if(!file||file.endsWith('.pdf'))return res.sendStatus(404);
  res.set({'Cache-Control':'private, no-store','Content-Type':file.endsWith('.png')?'image/png':'image/jpeg','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'});
  return res.sendFile(file,e=>{if(e&&!res.headersSent)next(e);});
 }catch(e){next(e);}
});
router.get('/document/:id',async(req,res,next)=>{const id=idOf(req,res);if(!id)return;
 if(!/^[1-9]\d{0,17}$/.test(req.params.id))return res.sendStatus(404);
 try{const r=await getPool().query(`SELECT "File_Reference" FROM sdc."CLINIC_DOCUMENTS" WHERE "Document_ID"=$1::bigint AND "Clinic_ID"=$2::bigint`,[req.params.id,id]);
 if(!r.rowCount)return res.sendStatus(404);const file=docService.documentPath(r.rows[0].File_Reference);if(!file)return res.sendStatus(404);
 const mime=file.endsWith('.pdf')?'application/pdf':file.endsWith('.png')?'image/png':'image/jpeg';res.set({'Cache-Control':'private, no-store','Content-Type':mime,'X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="clinic-document"'});
 return res.sendFile(file,e=>{if(e&&!res.headersSent)next(e);});}catch(e){next(e);}
});
module.exports=router;
