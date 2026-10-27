'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
// Use a private per-user directory outside public/ and OneDrive-synced project folders.
const ROOT=path.resolve(process.env.CLINIC_DOCUMENTS_DIR || path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.smart-dental-clinic'),'SmartDentalClinic','clinic-documents'));
const NUM=/^[1-9]\d{0,17}$/;
const FILETYPES={license:'facility_license',manager:'manager_identity'};
const allowedStatuses=new Set(['pending','approved','rejected']);
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const nonempty=(v,max=150)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;
function parseFields(raw){
 const f={name:String(raw?.clinic_name||'').trim(),city:String(raw?.city||'').trim(),area:String(raw?.area||'').trim(),
  phone:String(raw?.phone||'').trim(),email:String(raw?.email||'').trim().toLowerCase(),
  address:String(raw?.address||'').trim(),facilityLicense:String(raw?.facility_license_number||'').trim(),
  description:String(raw?.notes||'').trim(),latitude:Number(raw?.latitude),longitude:Number(raw?.longitude)};
 if(!nonempty(f.name)||!nonempty(f.city)||!nonempty(f.area)||!nonempty(f.phone,30)||!nonempty(f.address,2000)||!nonempty(f.facilityLicense)||
   !nonempty(f.email,254)||!emailPattern.test(f.email)||f.description.length>4000||
   typeof raw?.latitude!=='string'||!raw.latitude.trim()||typeof raw?.longitude!=='string'||!raw.longitude.trim()||
   !Number.isFinite(f.latitude)||!Number.isFinite(f.longitude)||f.latitude<-90||f.latitude>90||f.longitude<-180||f.longitude>180||
   !/^[-+]?\d{1,3}(?:\.\d{1,7})?$/.test(raw.latitude.trim())||!/^[-+]?\d{1,3}(?:\.\d{1,7})?$/.test(raw.longitude.trim()))
   return {error:'يرجى تعبئة جميع البيانات الإلزامية، بما فيها رقم ترخيص المنشأة والموقع الجغرافي الصحيح.'};
 return {data:f};
}
function docType(buffer){
 if(!Buffer.isBuffer(buffer))return null;
 if(buffer.subarray(0,5).toString()==='%PDF-')return {extension:'.pdf',mime:'application/pdf'};
 if(buffer.length>3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return {extension:'.jpg',mime:'image/jpeg'};
 if(buffer.length>8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {extension:'.png',mime:'image/png'};
 return null;
}
function checkedDocs(files,initial){
 const uploaded=Object.create(null);
 for(const key of Object.keys(FILETYPES)){
  const file=files?.[key]?.[0];
  if(!file){if(initial)return {error:'أرفق ترخيص المنشأة ووثيقة المدير قبل إرسال الطلب.'};continue;}
  const type=docType(file.buffer);
  if(!type||file.size===0||file.size>5*1024*1024)return {error:'المرفقات يجب أن تكون PDF أو JPG أو PNG وبحجم لا يتجاوز 5MB للملف.'};
  const original=String(file.originalname||'document').replace(/[\r\n\/\\\u0000-\u001f]/g,'').slice(0,180);
  uploaded[key]={buffer:file.buffer,...type,name:original||'document'+type.extension};
 }
 return {uploaded};
}
function labelStatus(row){
 if(row.Approval_Status==='approved')return 'approved';
 if(row.Approval_Status==='rejected')return 'rejected';
 if(row.Reviewed_At&&new Date(row.Reviewed_At)>new Date(row.Submitted_At))return 'needs_info';
 return 'pending';
}
async function saveDocuments(db,clinicId,uploaded,written){
 await fs.mkdir(ROOT,{recursive:true,mode:0o700});
 for(const [field,file] of Object.entries(uploaded)){
  const fileKey=crypto.randomUUID()+file.extension;
  const dest=path.join(ROOT,fileKey);
  await fs.writeFile(dest,file.buffer,{flag:'wx',mode:0o600});written.push(dest);
  const type=FILETYPES[field];
  const current=await db.query(`SELECT COALESCE(MAX("Version_Number"),0)+1 AS next_version FROM sdc."CLINIC_DOCUMENTS"
    WHERE "Clinic_ID"=$1::bigint AND "Document_Type"=$2::varchar(150)`,[clinicId,type]);
  await db.query(`UPDATE sdc."CLINIC_DOCUMENTS" SET "Is_Current"=false WHERE "Clinic_ID"=$1::bigint AND "Document_Type"=$2::varchar(150) AND "Is_Current"=true`,[clinicId,type]);
  await db.query(`INSERT INTO sdc."CLINIC_DOCUMENTS"("Document_Type","File_Reference","File_Name","Version_Number","Uploaded_At","Review_Status","Is_Current","Clinic_ID")
    VALUES($1::varchar(150),$2::varchar(512),$3::varchar(512),$4::integer,LOCALTIMESTAMP,'pending',true,$5::bigint)`,
   [type,fileKey,file.name,Number(current.rows[0].next_version),clinicId]);
 }
}
async function submitClinic(pool,actor,raw,files,clinicId=null){
 if(actor?.role!=='doctor'||!NUM.test(String(actor.doctorId)))return {status:'forbidden'};
 const parsed=parseFields(raw);if(parsed.error)return {status:'invalid',error:parsed.error};
 if(clinicId!==null&&!NUM.test(String(clinicId)))return {status:'invalid',error:'رقم الطلب غير صالح.'};
 const checked=checkedDocs(files,clinicId===null);if(checked.error)return {status:'invalid',error:checked.error};
 const db=await pool.connect(),written=[];
 try{
  await db.query('BEGIN');await db.query("SET LOCAL TIME ZONE 'Asia/Hebron'");
  await db.query("SELECT set_config('sdc.user_id',$1,true)",[String(actor.userId)]);
  const d=await db.query(`SELECT "Doctor_ID" FROM sdc."DOCTOR" WHERE "Doctor_ID"=$1::bigint AND "User_ID"=$2::bigint AND "License_Status"='verified' FOR UPDATE`,[actor.doctorId,actor.userId]);
  if(d.rowCount!==1){await db.query('ROLLBACK');return {status:'forbidden'};}
  let id;
  if(clinicId===null){
   const active=await db.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Manager_Doctor_ID"=$1::bigint AND "Approval_Status"='pending' LIMIT 1`,[actor.doctorId]);
   if(active.rowCount){await db.query('ROLLBACK');return {status:'duplicate',clinicId:String(active.rows[0].Clinic_ID)};}
   const v=parsed.data;
   const r=await db.query(`INSERT INTO sdc."CLINIC"("Clinic_Name","Clinic_Phone","Clinic_Email","Description","Facility_License_Number","Clinic_Status","Online_Booking_Enabled","Area","City","Address_Text","Latitude","Longitude","Approval_Status","Application_Notes","Submitted_At","Manager_Doctor_ID")
     VALUES($1,$2,$3,$4,$5,'inactive',false,$6,$7,$8,$9,$10,'pending',$11,LOCALTIMESTAMP,$12::bigint) RETURNING "Clinic_ID"`,
    [v.name,v.phone,v.email,v.description||null,v.facilityLicense,v.area,v.city,v.address,v.latitude,v.longitude,v.description||null,actor.doctorId]);
   id=String(r.rows[0].Clinic_ID);
  }else{
   const selected=await db.query(`SELECT "Clinic_ID","Approval_Status","Reviewed_At","Submitted_At" FROM sdc."CLINIC"
     WHERE "Clinic_ID"=$1::bigint AND "Manager_Doctor_ID"=$2::bigint FOR UPDATE`,[clinicId,actor.doctorId]);
   if(selected.rowCount!==1){await db.query('ROLLBACK');return {status:'not_found'};}
   const c=selected.rows[0];
   if(labelStatus(c)!=='needs_info'){await db.query('ROLLBACK');return {status:'locked'};}
   const v=parsed.data;
   await db.query(`UPDATE sdc."CLINIC" SET "Clinic_Name"=$1,"Clinic_Phone"=$2,"Clinic_Email"=$3,"Description"=$4,"Facility_License_Number"=$5,"Area"=$6,"City"=$7,"Address_Text"=$8,"Latitude"=$9,"Longitude"=$10,"Application_Notes"=$11,"Submitted_At"=LOCALTIMESTAMP
     WHERE "Clinic_ID"=$12::bigint`,[v.name,v.phone,v.email,v.description||null,v.facilityLicense,v.area,v.city,v.address,v.latitude,v.longitude,v.description||null,clinicId]);
   id=String(clinicId);
  }
  await saveDocuments(db,id,checked.uploaded,written);
  await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID")
   VALUES(LOCALTIMESTAMP,$1::varchar(150),'Clinic',$2::varchar(512),$3::text,$4::bigint)`,
   [clinicId===null?'clinic.application.submitted':'clinic.application.resubmitted',id,'تقديم أو تحديث طلب إنشاء عيادة',actor.userId]);
  await db.query('COMMIT');return {status:'ok',clinicId:id};
 }catch(error){try{await db.query('ROLLBACK')}catch{};await Promise.all(written.map(f=>fs.unlink(f).catch(()=>{})));throw error;}
 finally{db.release();}
}
async function pendingClinic(pool,doctorId){
 const r=await pool.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Manager_Doctor_ID"=$1::bigint AND "Approval_Status"='pending' ORDER BY "Submitted_At" DESC LIMIT 1`,[doctorId]);
 return r.rows[0]||null;
}
async function myClinic(pool,doctorId,clinicId=null){
 const r=await pool.query(`SELECT c.*,u."First_Name",u."Last_Name" FROM sdc."CLINIC" c
 JOIN sdc."DOCTOR" d ON d."Doctor_ID"=c."Manager_Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 WHERE c."Manager_Doctor_ID"=$1::bigint ${clinicId?'AND c."Clinic_ID"=$2::bigint':''}
 ORDER BY c."Submitted_At" DESC,c."Clinic_ID" DESC LIMIT 1`,clinicId?[doctorId,clinicId]:[doctorId]);
 return r.rows[0]||null;
}
async function listClinics(pool){
 const rs=await pool.query(`SELECT c."Clinic_ID",c."Clinic_Name",c."City",c."Approval_Status",c."Clinic_Status",c."Submitted_At",c."Reviewed_At",c."Review_Notes",c."Manager_Doctor_ID",u."First_Name",u."Last_Name",
 (SELECT COUNT(*)::integer FROM sdc."CLINIC_DOCUMENTS" f WHERE f."Clinic_ID"=c."Clinic_ID" AND f."Is_Current") AS doc_count
 FROM sdc."CLINIC" c JOIN sdc."DOCTOR" d ON d."Doctor_ID"=c."Manager_Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 ORDER BY CASE c."Approval_Status" WHEN 'pending' THEN 0 ELSE 1 END,c."Submitted_At" DESC,c."Clinic_ID" DESC LIMIT 200`);
 return rs.rows.map(c=>({...c,status:labelStatus(c)}));
}
async function findClinic(pool,id){
 if(!NUM.test(String(id)))return null;
 const rs=await pool.query(`SELECT c.*,u."First_Name",u."Last_Name",u."Email" AS "Manager_Email", d."License_Number" AS "Manager_License_Number"
 FROM sdc."CLINIC" c JOIN sdc."DOCTOR" d ON d."Doctor_ID"=c."Manager_Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID" WHERE c."Clinic_ID"=$1::bigint`,[id]);
 return rs.rows[0]?{...rs.rows[0],status:labelStatus(rs.rows[0])}:null;
}
async function clinicDocs(pool,id){
 const rs=await pool.query(`SELECT "Document_ID","Document_Type","File_Name","Review_Status","Uploaded_At"
 FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1::bigint AND "Is_Current"=true ORDER BY "Document_Type"`,[id]);return rs.rows;
}
async function reviewClinic(pool,actor,id,decision,reason,checks){
 if(actor?.role!=='admin'||!NUM.test(String(id))||!NUM.test(String(actor.userId)))return {status:'forbidden'};
 if(!['approve','reject','needs_info'].includes(decision)||!nonempty(reason,1000)||reason.trim().length<8)return {status:'invalid'};
 if(decision==='approve'&&!['details','contact','license','manager'].every(k=>checks?.[k]==='on'))return {status:'checks'};
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query("SET LOCAL TIME ZONE 'Asia/Hebron'");
  await db.query("SELECT set_config('sdc.user_id',$1,true)",[actor.userId]);
  const permission=await db.query('SELECT sdc.sdc_is_superadmin($1::bigint) AS allowed',[actor.userId]);
  if(permission.rows[0]?.allowed!==true){await db.query('ROLLBACK');return {status:'forbidden'};}
  const rs=await db.query(`SELECT "Approval_Status","Manager_Doctor_ID","Reviewed_At","Submitted_At",(SELECT d."User_ID" FROM sdc."DOCTOR" d WHERE d."Doctor_ID"=c."Manager_Doctor_ID") AS "Manager_User_ID" FROM sdc."CLINIC" c WHERE "Clinic_ID"=$1::bigint FOR UPDATE`,[id]);
  if(rs.rowCount!==1){await db.query('ROLLBACK');return {status:'not_found'};}
  if(rs.rows[0].Approval_Status!=='pending'){await db.query('ROLLBACK');return {status:'reviewed'};}
  if(decision==='approve'){
   const docs=await db.query(`SELECT COUNT(DISTINCT "Document_Type")::int AS present FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1::bigint AND "Is_Current"=true AND "Document_Type" IN ('facility_license','manager_identity')`,[id]);
   if(docs.rows[0]?.present!==2){await db.query('ROLLBACK');return {status:'documents'};}
  }
  const nextStatus=decision==='approve'?'approved':decision==='reject'?'rejected':'pending';
  const clinicStatus=decision==='approve'?'active':'inactive';
  await db.query(`UPDATE sdc."CLINIC" SET "Approval_Status"=$1::varchar(150),"Clinic_Status"=$2::varchar(150),"Reviewed_By_User_ID"=$3::bigint,"Reviewed_At"=LOCALTIMESTAMP,"Review_Notes"=$4::text WHERE "Clinic_ID"=$5::bigint`,
   [nextStatus,clinicStatus,actor.userId,reason.trim(),id]);
  if(decision==='approve')await db.query(`INSERT INTO sdc."WORKS_AT"("Start_Date","Membership_Status","Admin_Notes","Clinic_ID","Doctor_ID") VALUES(CURRENT_DATE,'active','مدير العيادة المعتمد',$1::bigint,$2::bigint)
     ON CONFLICT ("Clinic_ID","Doctor_ID") DO UPDATE SET "Membership_Status"='active'`,[id,rs.rows[0].Manager_Doctor_ID]);
  const notificationTitle=decision==='approve'?'تم اعتماد العيادة':decision==='reject'?'تم رفض طلب العيادة':'طلب استكمال بيانات العيادة';
  await db.query(`INSERT INTO sdc."NOTIFICATION"("Title","Body","Notification_Type","Created_At","Target_Type","Target_Reference","User_ID")
   VALUES($1::varchar(150),$2::text,'clinic.application',LOCALTIMESTAMP,'Clinic',$3::varchar(512),$4::bigint)`,
   [notificationTitle,reason.trim(),String(id),rs.rows[0].Manager_User_ID]);
  await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","Reason","User_ID")
   VALUES(LOCALTIMESTAMP,$1::varchar(150),'Clinic',$2::varchar(512),$3::text,$4::text,$5::bigint)`,
   [`clinic.application.${decision}`,String(id),'مراجعة طلب اعتماد العيادة',reason.trim(),actor.userId]);
  await db.query('COMMIT');return {status:'ok'};
 }catch(error){try{await db.query('ROLLBACK')}catch{};throw error;}finally{db.release();}
}
async function getDocument(pool,documentId){
 if(!NUM.test(String(documentId)))return null;
 const r=await pool.query(`SELECT d."Document_ID",d."Clinic_ID",d."File_Reference",d."File_Name",d."Document_Type",c."Manager_Doctor_ID"
 FROM sdc."CLINIC_DOCUMENTS" d JOIN sdc."CLINIC" c ON c."Clinic_ID"=d."Clinic_ID" WHERE d."Document_ID"=$1::bigint`,[documentId]);
 return r.rows[0]||null;
}
function documentPath(ref){if(typeof ref!=='string'||!/^[0-9a-f-]{36}\.(pdf|jpg|png)$/.test(ref))return null;return path.join(ROOT,ref);}
module.exports={parseFields,docType,checkedDocs,labelStatus,submitClinic,myClinic,pendingClinic,listClinics,findClinic,clinicDocs,reviewClinic,getDocument,documentPath};
