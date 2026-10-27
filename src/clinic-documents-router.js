'use strict';
// Reuse original profile/Documents Log and secure private document storage.
const express=require('express');
const multer=require('multer');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {getPool}=require('../db/pool');
const {clinicId}=require('./clinic-settings-service');
const {validateSessionCsrf}=require('./auth/session');
const docs=require('./clinic-onboarding/service');
const router=express.Router();
const kinds=new Set(['general_document','insurance_certificate','facility_license','manager_identity']);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:3,parts:5}}).single('document');
router.post('/documents/upload',(req,res,next)=>upload(req,res,e=>e?res.status(422).send('الملف يتجاوز 5MB أو غير صالح.'):next()),async(req,res,next)=>{
 const clinic=clinicId(req);if(!clinic)return res.sendStatus(403);
 if(!validateSessionCsrf(req))return res.sendStatus(403);
 const kind=String(req.body?.document_type||'');const type=docs.docType(req.file?.buffer);
 if(!kinds.has(kind)||!type||!req.file?.size||req.file.size>5*1024*1024)return res.status(422).send('اختر نوع مستند وملف PDF أو JPG أو PNG بحجم لا يزيد عن 5MB.');
 const key=crypto.randomUUID()+type.extension,filepath=docs.documentPath(key);
 if(!filepath)return res.sendStatus(500);
 const name=String(req.file.originalname||'clinic-document').replace(/[\x00-\x1f\\/]/g,'_').slice(0,180);
 let db;try{db=await getPool().connect();}catch(e){return next(e);}
 let saved=false,committed=false;
 try{
  await fs.mkdir(path.dirname(filepath),{recursive:true,mode:0o700});await fs.writeFile(filepath,req.file.buffer,{flag:'wx',mode:0o600});saved=true;
  await db.query('BEGIN');await db.query("SELECT set_config('sdc.user_id',$1,true)",[req.sdcActor.userId]);
  const lock=await db.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active' FOR UPDATE`,[clinic]);
  if(!lock.rowCount){await db.query('ROLLBACK');return res.sendStatus(403);}
  const next=await db.query(`SELECT COALESCE(MAX("Version_Number"),0)+1 AS next FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1::bigint AND "Document_Type"=$2`,[clinic,kind]);
  const requiresReview=['facility_license','manager_identity'].includes(kind);
  if(!requiresReview)await db.query(`UPDATE sdc."CLINIC_DOCUMENTS" SET "Is_Current"=false WHERE "Clinic_ID"=$1::bigint AND "Document_Type"=$2 AND "Is_Current"=true`,[clinic,kind]);
  await db.query(`INSERT INTO sdc."CLINIC_DOCUMENTS"("Document_Type","File_Reference","File_Name","Version_Number","Uploaded_At","Review_Status","Is_Current","Clinic_ID") VALUES($1,$2,$3,$4::int,LOCALTIMESTAMP,$5,$6::boolean,$7::bigint)`,[kind,key,name,next.rows[0].next,requiresReview?'pending':'uploaded',!requiresReview,clinic]);
  await db.query('COMMIT');committed=true;return res.redirect(303,'/clinic/profile?saved=1#sdcClinicFileVersions');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});console.error('[CLINIC_DOCUMENT_UPLOAD]',e.code||e.message);next(e);}finally{db.release();if(saved&&!committed)await fs.unlink(filepath).catch(()=>{});}
});
module.exports=router;
