'use strict';
// Private visit files. Stored outside /public; never return an unchecked filesystem path.
const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {docType}=require('../clinic-onboarding/service');const {validId}=require('./service');const {business}=require('./clinical-service');
const root=path.resolve(process.env.SDC_VISIT_FILES_DIR||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.smart-dental-clinic'),'SmartDentalClinic','visit-files'));
function securePath(ref){if(!/^[a-f0-9-]{36}\.(pdf|png|jpg)$/.test(String(ref||'')))return null;return path.join(root,ref);}
function cleanName(original){return String(original||'visit-file').replace(/[\x00-\x1f\\\/"\r\n]/g,'_').slice(0,180);}
async function upload(pool,c,bookingId,file,description){if(!validId(bookingId)||!file?.size||file.size>5*1024*1024)throw business('يجب اختيار ملف لا يزيد عن 5MB.');const type=docType(file.buffer);if(!type)throw business('الصيغ المسموحة PDF وJPG وPNG فقط.');const note=String(description||'').trim();if(note.length>2000)throw business('ملاحظة الملف طويلة جدًا.');const key=crypto.randomUUID()+type.extension,filepath=securePath(key);let saved=false;const db=await pool.connect();try{
  await fs.mkdir(root,{recursive:true,mode:0o700});await fs.writeFile(filepath,file.buffer,{flag:'wx',mode:0o600});saved=true;
  await db.query('BEGIN');await db.query("SELECT set_config('sdc.user_id',$1::text,true)",[c.user]);
  const v=await db.query(`SELECT v."Visit_ID"::text id,v."Report_Approved_At" approved FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") WHERE b."Booking_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint AND b."Clinic_ID"=$3::bigint FOR UPDATE OF v`,[bookingId,c.doc,c.id]);
  if(!v.rowCount)throw business('الزيارة غير موجودة ضمن صلاحياتك.',404);if(v.rows[0].approved)throw business('لا يمكن تغيير مرفقات زيارة بعد اعتماد التقرير.',409);
  await db.query(`INSERT INTO sdc."VISIT_VISIT_FILES"("File_Name","File_Reference","Description","Uploaded_At","Included_In_Report","File_Type","Visit_ID") VALUES($1,$2,$3,LOCALTIMESTAMP,false,$4,$5::bigint)`,[cleanName(file.originalname),key,note||null,type.mime,v.rows[0].id]);
  await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,'visit.attachment.uploaded','Visit',$1,$2,$3::bigint)`,[v.rows[0].id,`رفع ملف زيارة: ${key}`,c.user]);await db.query('COMMIT');return {bookingId};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});if(saved)await fs.unlink(filepath).catch(()=>{});throw e;}finally{db.release();}}
async function get(pool,c,bookingId,fileId){if(!validId(bookingId)||!validId(fileId))return null;const q=await pool.query(`SELECT f."File_Name" name,f."File_Reference" reference,f."File_Type" type FROM sdc."VISIT_VISIT_FILES" f JOIN sdc."VISIT" v ON v."Visit_ID"=f."Visit_ID" JOIN sdc."BOOKING" b USING("Booking_ID") WHERE f."File_ID"=$1::bigint AND b."Booking_ID"=$2::bigint AND b."Doctor_ID"=$3::bigint AND b."Clinic_ID"=$4::bigint`,[fileId,bookingId,c.doc,c.id]);if(!q.rowCount)return null;const f=q.rows[0],location=securePath(f.reference);if(!location)return null;const stat=await fs.stat(location).catch(()=>null);if(!stat?.isFile())return null;return {...f,location};}
module.exports={upload,get,securePath};
