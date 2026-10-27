'use strict';
const fs=require('node:fs/promises');const visitFiles=require('./visit-files');
const pdf=require('./report-pdf');const {business}=require('./clinical-service');const {validId}=require('./service');
async function selectedImages(files){
 const candidates=files.filter(x=>['image/png','image/jpeg'].includes(x.mime));
 if(candidates.length>12)throw business('عدد صور التقرير يتجاوز 12؛ قلّل الصور المختارة قبل الاعتماد.',422);
 const images=[];let total=0;
 for(const file of candidates){
  const location=visitFiles.securePath(file.reference);
  if(!location)throw business('مرجع مرفق التقرير غير صالح.',409);
  const stat=await fs.stat(location).catch(()=>null);
  if(!stat?.isFile()||stat.size>5*1024*1024||stat.size<8)throw business('صورة مرفق التقرير مفقودة أو غير صالحة.',409);
  total+=stat.size;if(total>24*1024*1024)throw business('حجم صور التقرير يتجاوز 24MB؛ قلّل الصور المختارة.',422);
  const bytes=await fs.readFile(location);
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!(file.mime==='image/png'&&png||file.mime==='image/jpeg'&&jpg))throw business('نوع مرفق التقرير لا يطابق محتواه.',409);
  images.push({name:file.name,src:`data:${file.mime};base64,${bytes.toString('base64')}`});
 }
 return images;
}
async function approve(pool,c,bookingId){if(!validId(bookingId))throw business('رقم الحجز غير صالح.');const db=await pool.connect();let out=null,committed=false;
try{await db.query('BEGIN');await db.query("SELECT set_config('sdc.user_id',$1::text,true)",[c.user]);
 // Global write gate used in the existing database schema; preserve a consistent
 // immutable snapshot while the local PDF renderer runs.
 await db.query('SELECT pg_advisory_xact_lock(534443,570406)');
 const r=await db.query(`SELECT v."Visit_ID"::text id,v."Visit_Status" status,v."Report_Approved_At" approved,v."Chief_Complaint" complaint,v."Examination_Notes" examination,v."Recommendations" recommendations,
 v."Follow_Up_Type" followup_type,to_char(v."Suggested_Date",'YYYY-MM-DD') followup_date,v."Follow_Up_Notes" followup_notes,
 b."Booking_Status" booking_status,b."Patient_ID"::text patient_id,to_char(b."Appointment_Date",'YYYY-MM-DD') date,s."Service_Name" service,
 b."Appointment_Date"+b."Start_Time" <= (now() AT TIME ZONE 'Asia/Hebron') AS scheduled_time_reached,
 clinic."Clinic_Name" clinic_name,pu."First_Name"||' '||pu."Last_Name" patient_name,du."First_Name"||' '||du."Last_Name" doctor_name
 FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" JOIN sdc."PATIENT" patient ON patient."Patient_ID"=b."Patient_ID" JOIN sdc."USER" pu ON pu."User_ID"=patient."User_ID" JOIN sdc."DOCTOR" d ON d."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" du ON du."User_ID"=d."User_ID" JOIN sdc."CLINIC" clinic ON clinic."Clinic_ID"=b."Clinic_ID" JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID" WHERE b."Booking_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint AND b."Clinic_ID"=$3::bigint FOR UPDATE OF v`,[bookingId,c.doc,c.id]);
 if(!r.rowCount)throw business('لا توجد زيارة تخص هذا الطبيب والعيادة.',404);const visit=r.rows[0];
 if(visit.approved)throw business('التقرير معتمد بالفعل ولا يمكن اعتماده مرة ثانية.',409);
 if(visit.status!=='completed'||visit.booking_status!=='completed'||!visit.complaint||!visit.examination)throw business('يمكن اعتماد تقرير زيارة مكتملة فقط مع الشكوى والفحص.',409);
 if(visit.scheduled_time_reached===false)throw business('لا يمكن اعتماد التقرير قبل وقت الموعد المحدد.',409);
 const draft=await db.query(`SELECT COUNT(*)::int total FROM sdc."PRESCRIPTION" WHERE "Visit_ID"=$1::bigint AND "Prescription_Status"='draft'`,[visit.id]);if(draft.rows[0]?.total>0)throw business('يجب إصدار الوصفات المسودة أو إلغاؤها قبل اعتماد التقرير.',409);
 const [diagnoses,procedures,medications,findings,surfaces,files,odontogram,stages]= [
 await db.query(`SELECT "Tooth_Number" tooth,"Diagnosis_Text" text FROM sdc."VISIT_DIAGNOSES" WHERE "Visit_ID"=$1::bigint ORDER BY "Diagnosis_ID"`,[visit.id]),
 await db.query(`SELECT pr."Tooth_Number" tooth,pr."Quantity"::text quantity,pr."Unit_Price_Snapshot"::text price,s."Service_Name" service FROM sdc."PROCEDURE" pr JOIN sdc."SERVICE" s USING("Service_ID") WHERE pr."Visit_ID"=$1::bigint AND pr."Procedure_Status"='completed' ORDER BY pr."Procedure_ID"`,[visit.id]),
 await db.query(`SELECT m."Medication_Name" name,m."Dosage" dosage,m."Frequency" frequency,m."Duration" duration,m."Route" route FROM sdc."PRESCRIPTION" p JOIN sdc."PRESCRIPTION_MEDICATIONS" m USING("Prescription_ID") WHERE p."Visit_ID"=$1::bigint AND p."Prescription_Status"='issued' ORDER BY p."Prescription_ID",m."Medication_ID"`,[visit.id]),
 await db.query(`SELECT "Clinical_Findings" finding FROM sdc."VISIT_CLINICAL_FINDINGS" WHERE "Visit_ID"=$1::bigint ORDER BY "Clinical_Findings"`,[visit.id]),
 await db.query(`SELECT "Tooth_Number" tooth,"Surface" surface,"Note" note FROM sdc."VISIT_TOOTH_SURFACE_NOTES" WHERE "Visit_ID"=$1::bigint ORDER BY "Note_ID"`,[visit.id]),
 await db.query(`SELECT "File_Name" name,"File_Reference" reference,"File_Type" mime FROM sdc."VISIT_VISIT_FILES" WHERE "Visit_ID"=$1::bigint AND "Included_In_Report"=true ORDER BY "File_ID"`,[visit.id]),
 await db.query(`SELECT "Tooth_Number" tooth,"Tooth_Status" status FROM sdc."VISIT_ODONTOGRAM" WHERE "Visit_ID"=$1::bigint ORDER BY "Tooth_Number"`,[visit.id]),
 await db.query(`SELECT p."Plan_Name" plan,s."Stage_Order" step,s."Tooth_Number" tooth,s."Description" description,s."Stage_Status" status FROM sdc."TREATMENT_STAGE" s JOIN sdc."TREATMENT_PLAN" p ON p."Plan_ID"=s."Plan_ID" WHERE p."Doctor_ID"=$1::bigint AND p."Clinic_ID"=$2::bigint AND p."Patient_ID"=$3::bigint AND EXISTS(SELECT 1 FROM sdc."BOOKING" bk WHERE bk."Booking_ID"=$4::bigint AND bk."Plan_ID"=p."Plan_ID") ORDER BY p."Plan_ID",s."Stage_Order" LIMIT 200`,[c.doc,c.id,visit.patient_id,bookingId])
 ];
 // Read only image files already selected for THIS locked visit. Private PDFs stay protected downloads;
 // a PDF cannot be safely inlined by Chromium's HTML-to-PDF engine.
 const images=await selectedImages(files.rows);
 out=await pdf.generate({visit,diagnoses:diagnoses.rows,procedures:procedures.rows,medications:medications.rows,findings:findings.rows,surfaces:surfaces.rows,files:files.rows,odontogram:odontogram.rows,stages:stages.rows,images},visit.id);
 const save=await db.query(`UPDATE sdc."VISIT" SET "Report_Approved_At"=LOCALTIMESTAMP,"Approved_Report_File_Reference"=$1::varchar(512) WHERE "Visit_ID"=$2::bigint AND "Report_Approved_At" IS NULL AND "Visit_Status"='completed' RETURNING "Visit_ID"`,[out.reference,visit.id]);
 if(!save.rowCount)throw business('تعذّر اعتماد التقرير بسبب تعديل متزامن.',409);
 await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,'visit.report.approved','Visit',$1::varchar(512),$2::text,$3::bigint)`,[visit.id,`اعتماد تقرير طبي محفوظ كملف PDF؛ SHA256=${out.hash}`,c.user]);
 await db.query('COMMIT');committed=true;return {bookingId,visitId:visit.id,reference:out.reference};
}catch(error){if(!committed){await db.query('ROLLBACK').catch(()=>{});await pdf.remove(out);}throw error;}finally{db.release();}}
async function fileForBooking(pool,c,bookingId){if(!validId(bookingId))return null;const r=await pool.query(`SELECT v."Approved_Report_File_Reference" reference FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") WHERE b."Booking_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint AND b."Clinic_ID"=$3::bigint AND v."Report_Approved_At" IS NOT NULL`,[bookingId,c.doc,c.id]);if(!r.rowCount)return null;return pdf.find(r.rows[0].reference);}
module.exports={approve,fileForBooking,selectedImages};
