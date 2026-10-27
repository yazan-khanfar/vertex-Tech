'use strict';
// Remaining visit workflows. No schema changes. All operations are scoped to the
// signed-in doctor + selected clinic and serialized on the VISIT row.
const {validId}=require('./service');
const {business,text,tooth,positive}=require('./clinical-service');
const {localNow}=require('../appointments/service');
const allowedFindings=new Set(['وجود تسوس','ألم عند الضغط','تورم','حركة في السن','نزف لثوي','حساسية حرارية']);
function listJson(raw,max){if(typeof raw!=='string'||raw.length>12000)throw business('بيانات القائمة غير صالحة.');let value;try{value=JSON.parse(raw);}catch{throw business('صيغة القائمة غير صالحة.');}if(!Array.isArray(value)||!value.length||value.length>max)throw business('عدد العناصر غير صالح.');return value;}
function date(value){const d=String(value||'');if(!/^\d{4}-\d\d-\d\d$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d||d<localNow().date)throw business('تاريخ التسليم غير صالح.');return d;}
async function extraAction(pool,c,b){const action=String(b.action||'');const allowed=new Set(['findings','surface_note','prescription_multi','add_medication','lab_order','recommendations','toggle_report_file','void_prescription']);if(!allowed.has(action))throw business('الإجراء غير مدعوم.');if(!validId(b.booking_id))throw business('رقم الموعد غير صالح.');const db=await pool.connect();try{
 await db.query('BEGIN');await db.query("SELECT set_config('sdc.user_id',$1::text,true)",[c.user]);
 const found=await db.query(`SELECT v."Visit_ID"::text id,v."Report_Approved_At" approved,v."Visit_Status" status FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" WHERE b."Booking_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint AND b."Clinic_ID"=$3::bigint FOR UPDATE OF v`,[b.booking_id,c.doc,c.id]);
 if(!found.rowCount)throw business('الزيارة ليست ضمن صلاحيات هذا الطبيب.',404);const v=found.rows[0];if(v.approved)throw business('التقرير الطبي معتمد؛ لا يسمح بتغيير بيانات الزيارة أو مرفقات التقرير.',409);if(!['in_progress','completed'].includes(v.status))throw business('ابدأ الزيارة أولًا.',409);
 if(action==='findings'){
  const findings=String(b.findings||'').split('|').filter(Boolean);
  if(findings.length>allowedFindings.size||new Set(findings).size!==findings.length||findings.some(x=>!allowedFindings.has(x)))throw business('خيار فحص غير مدعوم.');
  await db.query(`DELETE FROM sdc."VISIT_CLINICAL_FINDINGS" WHERE "Visit_ID"=$1::bigint`,[v.id]);for(const item of findings)await db.query(`INSERT INTO sdc."VISIT_CLINICAL_FINDINGS"("Clinical_Findings","Visit_ID") VALUES($1,$2::bigint)`,[item,v.id]);
 }else if(action==='surface_note'){
  const t=tooth(b.tooth_number),surface=String(b.surface||''),note=text(b.surface_note,2000,true);
  if(!t||!['M','D','O','B','L'].includes(surface))throw business('اختر سنًا واحدًا وسطحًا صحيحًا.');
  await db.query(`INSERT INTO sdc."VISIT_TOOTH_SURFACE_NOTES"("Tooth_Number","Surface","Note","Visit_ID") VALUES($1::smallint,$2,$3,$4::bigint)`,[t,surface,note,v.id]);
 }else if(action==='prescription_multi'){
  const medicines=listJson(b.medications,12);const prescriptionStatus=String(b.prescription_status||'draft');if(!['draft','issued'].includes(prescriptionStatus))throw business('حالة الوصفة الجديدة غير صالحة.');const clean=medicines.map(m=>({name:text(m.name,150,true),dose:text(m.dose,150,true),frequency:text(m.frequency,150,true),duration:text(m.duration,150,true),route:text(m.route,150,true),instructions:text(m.instructions,2000)}));
  const r=await db.query(`INSERT INTO sdc."PRESCRIPTION"("Prescription_Status","Created_At","Issued_At","Visit_ID") VALUES($2,LOCALTIMESTAMP,CASE WHEN $2='issued' THEN LOCALTIMESTAMP ELSE NULL END,$1::bigint) RETURNING "Prescription_ID"::text id`,[v.id,prescriptionStatus]);
  for(const m of clean)await db.query(`INSERT INTO sdc."PRESCRIPTION_MEDICATIONS"("Medication_Name","Dosage","Frequency","Duration","Route","Instructions","Prescription_ID") VALUES($1,$2,$3,$4,$5,$6,$7::bigint)`,[m.name,m.dose,m.frequency,m.duration,m.route,m.instructions||null,r.rows[0].id]);
 }else if(action==='add_medication'){
  if(!validId(b.prescription_id))throw business('الوصفة غير صالحة.');const med={name:text(b.medication,150,true),dose:text(b.dosage,150,true),frequency:text(b.frequency,150,true),duration:text(b.duration,150,true),route:text(b.route,150,true),instructions:text(b.instructions,2000)};
  const rx=await db.query(`SELECT "Prescription_ID" FROM sdc."PRESCRIPTION" WHERE "Prescription_ID"=$1::bigint AND "Visit_ID"=$2::bigint AND "Prescription_Status"='draft' FOR UPDATE`,[b.prescription_id,v.id]);if(!rx.rowCount)throw business('الوصفة غير موجودة أو تم إصدارها.',409);
  await db.query(`INSERT INTO sdc."PRESCRIPTION_MEDICATIONS"("Medication_Name","Dosage","Frequency","Duration","Route","Instructions","Prescription_ID") VALUES($1,$2,$3,$4,$5,$6,$7::bigint)`,[med.name,med.dose,med.frequency,med.duration,med.route,med.instructions||null,b.prescription_id]);
 }else if(action==='void_prescription'){
  if(!validId(b.prescription_id))throw business('الوصفة غير صالحة.');const reason=text(b.void_reason,2000,true);
  const changed=await db.query(`UPDATE sdc."PRESCRIPTION" SET "Prescription_Status"='void',"Voided_At"=LOCALTIMESTAMP,"Void_Reason"=$1 WHERE "Prescription_ID"=$2::bigint AND "Visit_ID"=$3::bigint AND "Prescription_Status" IN('draft','issued') RETURNING "Prescription_ID"`,[reason,b.prescription_id,v.id]);
  if(!changed.rowCount)throw business('الوصفة غير موجودة أو سبق إبطالها.',409);
 }else if(action==='lab_order'){
  if(!validId(b.laboratory_id))throw business('اختر مختبرًا مرتبطًا بالعيادة.');const due=date(b.delivery_date),notes=text(b.lab_notes,2000);const items=listJson(b.lab_items,10).map(i=>({work:text(i.work,150,true),tooth:tooth(i.tooth),area:text(i.area,2000),quantity:positive(i.quantity),material:text(i.material,150),shade:text(i.shade,150),instructions:text(i.instructions,2000)}));
  const relation=await db.query(`SELECT 1 FROM sdc."WORKS_WITH" WHERE "Clinic_ID"=$1::bigint AND "Laboratory_ID"=$2::bigint AND "Relationship_Status"='active'`,[c.id,b.laboratory_id]);if(!relation.rowCount)throw business('المختبر ليس نشطًا أو ليس مرتبطًا بالعيادة.',403);
  let attachment=null;
  if(b.attachment_file_id){if(!validId(b.attachment_file_id))throw business('مرفق الطلب غير صالح.');
   const saved=await db.query(`SELECT "File_Reference" reference FROM sdc."VISIT_VISIT_FILES" WHERE "File_ID"=$1::bigint AND "Visit_ID"=$2::bigint`,[b.attachment_file_id,v.id]);if(!saved.rowCount)throw business('مرفق الطلب ليس من ملفات هذه الزيارة.',403);
   attachment=saved.rows[0].reference;}
  const r=await db.query(`INSERT INTO sdc."LAB_ORDER"("Created_At","Expected_Delivery_Date","Order_Status","Notes","Attachment_Reference","Laboratory_ID","Visit_ID") VALUES(LOCALTIMESTAMP,$1::date,'draft',$2,$3,$4::bigint,$5::bigint) RETURNING "Lab_Order_ID"::text id`,[due,notes||null,attachment,b.laboratory_id,v.id]);
  for(const item of items)await db.query(`INSERT INTO sdc."LAB_ORDER_ITEMS"("Work_Type","Tooth_Number","Region_Description","Quantity","Material","Shade","Instructions","Lab_Order_ID") VALUES($1,$2::smallint,$3,$4::numeric(12,2),$5,$6,$7,$8::bigint)`,[item.work,item.tooth,item.area||null,item.quantity,item.material||null,item.shade||null,item.instructions||null,r.rows[0].id]);
 }else if(action==='recommendations'){
  const advice=text(b.recommendations,5000);await db.query(`UPDATE sdc."VISIT" SET "Recommendations"=$1 WHERE "Visit_ID"=$2::bigint`,[advice||null,v.id]);
 }else if(action==='toggle_report_file'){
  if(!validId(b.file_id)||!['yes','no'].includes(b.include))throw business('المرفق غير صالح.');const changed=await db.query(`UPDATE sdc."VISIT_VISIT_FILES" SET "Included_In_Report"=$1::boolean WHERE "File_ID"=$2::bigint AND "Visit_ID"=$3::bigint RETURNING "File_ID"`,[b.include==='yes',b.file_id,v.id]);if(!changed.rowCount)throw business('المرفق غير مرتبط بالزيارة.',404);
 }
 await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,$1,'Visit',$2,$3,$4::bigint)`,[`visit.clinical.${action}`,v.id,`حفظ بيانات الزيارة (${action})`,c.user]);await db.query('COMMIT');return {bookingId:b.booking_id};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}}
module.exports={extraAction,allowedFindings};
