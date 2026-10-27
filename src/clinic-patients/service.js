'use strict';
// Clinic patients: use the existing REGISTERED_AT association, never infer
// access to another clinic's records from a global patient ID.
const { normalizeGender, genderLabel } = require('../patients/gender');
const ID=/^[1-9]\d{0,17}$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOOD=new Set(['A+','A-','B+','B-','AB+','AB-','O+','O-','unknown']);
const GENDER=new Set(['male','female']);
const clean=(v,max=150)=>String(v??'').trim().slice(0,max+1);
const validDate=s=>/^\d{4}-\d\d-\d\d$/.test(s)&&!Number.isNaN(new Date(s+'T12:00:00Z').getTime())&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s&&s<=new Date().toISOString().slice(0,10)&&s>='1900-01-01';
const lines=s=>[...new Set(String(s??'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
function parsePatient(body){
 const p={first:clean(body.clinic_patient_first_name),last:clean(body.clinic_patient_last_name),birth:clean(body.clinic_patient_birthdate,10),gender:normalizeGender(body.clinic_patient_gender),phone:clean(body.clinic_patient_phone,30),email:clean(body.clinic_patient_email,254).toLowerCase(),blood:clean(body.blood_type,10)||'unknown',notes:clean(body.health_notes,3000)||'لا توجد ملاحظات صحية مسجلة',allergies:lines(body.clinic_patient_allergies),chronic:lines(body.clinic_patient_chronic_diseases),medications:lines(body.clinic_patient_current_medications)};
 if(!p.first||p.first.length>150||!p.last||p.last.length>150||!validDate(p.birth)||!GENDER.has(p.gender)||!p.phone||p.phone.length>30||p.email&&!EMAIL.test(p.email)||!BLOOD.has(p.blood)||p.notes.length>3000||[p.allergies,p.chronic,p.medications].some(a=>a.length>30||a.some(s=>s.length>150)))return null;
 return p;
}
async function list(pool,clinic){
 const r=await pool.query(`SELECT p."Patient_ID"::text AS id,u."First_Name"||' '||u."Last_Name" AS name,
 u."Phone" AS phone,u."Email" AS email,u."Account_Status" AS status,
 (SELECT max(b."Appointment_Date") FROM sdc."BOOKING" b JOIN sdc."VISIT" v ON v."Booking_ID"=b."Booking_ID" WHERE b."Clinic_ID"=$1::bigint AND b."Patient_ID"=p."Patient_ID")::text AS last_visit
 FROM sdc."REGISTERED_AT" a JOIN sdc."PATIENT" p ON p."Patient_ID"=a."Patient_ID"
 JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
 WHERE a."Clinic_ID"=$1::bigint ORDER BY u."First_Name",u."Last_Name",p."Patient_ID" LIMIT 1000`,[clinic]);
 return r.rows.map(x=>({...x,initials:x.name.split(/\s+/).slice(0,2).map(v=>v[0]).join(''),lastVisit:x.last_visit||null}));
}
async function detail(pool,clinic,id){
 if(!ID.test(String(id||'')))return null;
 const r=await pool.query(`SELECT p."Patient_ID"::text AS id,p."Date_Of_Birth"::text AS dob,p."Gender" AS gender,p."Blood_Type" AS blood,p."Health_Notes" AS notes,
 u."First_Name"||' '||u."Last_Name" AS name,u."Phone" AS phone,u."Email" AS email
 FROM sdc."REGISTERED_AT" a JOIN sdc."PATIENT" p ON p."Patient_ID"=a."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
 WHERE a."Clinic_ID"=$1::bigint AND a."Patient_ID"=$2::bigint`,[clinic,id]);
 if(!r.rowCount)return null;
 const [allergies,chronic,meds,visits,plans,invoices]=await Promise.all([
 pool.query(`SELECT "Allergies" AS name FROM sdc."PATIENT_ALLERGIES" WHERE "Patient_ID"=$1::bigint ORDER BY "Allergies"`,[id]),
 pool.query(`SELECT "Chronic_Diseases" AS name FROM sdc."PATIENT_CHRONIC_DISEASES" WHERE "Patient_ID"=$1::bigint ORDER BY "Chronic_Diseases"`,[id]),
 pool.query(`SELECT "Current_Medications" AS name FROM sdc."PATIENT_CURRENT_MEDICATIONS" WHERE "Patient_ID"=$1::bigint ORDER BY "Current_Medications"`,[id]),
 pool.query(`SELECT b."Booking_ID"::text AS booking_id,v."Visit_ID"::text AS visit_id,to_char(b."Appointment_Date",'YYYY-MM-DD') AS date,
 s."Service_Name" AS service,u."First_Name"||' '||u."Last_Name" AS doctor,v."Visit_Status" AS status,
 v."Report_Approved_At" IS NOT NULL AS report_approved
 FROM sdc."BOOKING" b JOIN sdc."VISIT" v ON v."Booking_ID"=b."Booking_ID"
 JOIN sdc."DOCTOR" d ON d."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID"
 WHERE b."Clinic_ID"=$1::bigint AND b."Patient_ID"=$2::bigint ORDER BY b."Appointment_Date" DESC LIMIT 100`,[clinic,id]),
 pool.query(`SELECT t."Plan_ID"::text AS id,t."Plan_Name" AS name,t."Plan_Status" AS status,to_char(t."Start_Date",'YYYY-MM-DD') AS start,t."Estimated_Cost"::text AS cost,
 u."First_Name"||' '||u."Last_Name" AS doctor
 FROM sdc."TREATMENT_PLAN" t JOIN sdc."DOCTOR" d ON d."Doctor_ID"=t."Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 WHERE t."Clinic_ID"=$1::bigint AND t."Patient_ID"=$2::bigint ORDER BY t."Start_Date" DESC LIMIT 50`,[clinic,id]),
 pool.query(`SELECT i."Invoice_ID"::text AS id,i."Invoice_Status" AS status,
 COALESCE((SELECT sum(it."Quantity"*it."Unit_Price"-it."Discount_Amount") FROM sdc."INVOICE_INVOICE_ITEMS" it WHERE it."Invoice_ID"=i."Invoice_ID"),0)::numeric AS total,
 COALESCE((SELECT sum(pay."Amount") FROM sdc."RECORDS_PAYMENT" pay WHERE pay."Invoice_ID"=i."Invoice_ID"),0)::numeric AS paid
 FROM sdc."INVOICE" i WHERE i."Clinic_ID"=$1::bigint AND i."Patient_ID"=$2::bigint ORDER BY i."Created_At" DESC LIMIT 100`,[clinic,id])
 ]);
 const bill=invoices.rows.reduce((a,i)=>{if(i.status==='void')return a;return {total:a.total+Number(i.total),remaining:a.remaining+Math.max(0,Number(i.total)-Number(i.paid))};},{total:0,remaining:0});
 return {...r.rows[0],genderLabel:genderLabel(r.rows[0].gender),allergies:allergies.rows.map(x=>x.name),chronic:chronic.rows.map(x=>x.name),medications:meds.rows.map(x=>x.name),visits:visits.rows,plans:plans.rows,invoices:invoices.rows,bill};
}
async function create(pool,clinic,user,body){
 if(!ID.test(String(clinic||''))||!ID.test(String(user||'')))return {status:'forbidden'};
 const p=parsePatient(body);if(!p)return {status:'invalid'};
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query("SELECT set_config('sdc.user_id',$1,true)",[user]);
  const allowed=await db.query(`SELECT 1 FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Clinic_Status"='active' AND "Approval_Status"='approved' FOR UPDATE`,[clinic]);
  if(!allowed.rowCount){await db.query('ROLLBACK');return {status:'forbidden'};}
  // Do not link existing patient accounts across clinics on the strength of a
  // supplied email/phone. That requires a separate verified patient consent.
  const existing=await db.query(`SELECT 1 FROM sdc."USER" u JOIN sdc."PATIENT" p ON p."User_ID"=u."User_ID"
    WHERE ($1::varchar(254) <> '' AND lower(u."Email")=$1::varchar(254))
       OR (u."Phone"=$2::varchar(30) AND p."Date_Of_Birth"=$3::date) LIMIT 1`,[p.email,p.phone,p.birth]);
  if(existing.rowCount){await db.query('ROLLBACK');return {status:'exists'};}
  const role=await db.query(`SELECT "Role_ID" FROM sdc."ROLE" WHERE "Role_Name"='Patient' AND "Role_Scope"='System'`);
  if(role.rowCount!==1){await db.query('ROLLBACK');return {status:'role_missing'};}
  const u=await db.query(`INSERT INTO sdc."USER"("First_Name","Last_Name","Email","Phone","Password_Hash","Account_Status","Created_At","Preferred_Language","Two_Factor_Enabled","Login_Enabled","Role_ID")
    VALUES($1::varchar(150),$2::varchar(150),$3::varchar(254),$4::varchar(30),NULL,'active',LOCALTIMESTAMP,'ar',false,false,$5::bigint) RETURNING "User_ID"`,[p.first,p.last,p.email||null,p.phone,role.rows[0].Role_ID]);
  const patient=await db.query(`INSERT INTO sdc."PATIENT"("Date_Of_Birth","Gender","Blood_Type","Health_Notes","User_ID") VALUES($1::date,$2::varchar(150),$3::varchar(10),$4::text,$5::bigint) RETURNING "Patient_ID"::text AS id`,[p.birth,p.gender,p.blood,p.notes,u.rows[0].User_ID]);
  const id=patient.rows[0].id;
  await db.query(`INSERT INTO sdc."REGISTERED_AT"("Patient_ID","Clinic_ID") VALUES($1::bigint,$2::bigint)`,[id,clinic]);
  for(const [table,col,values] of [['PATIENT_ALLERGIES','Allergies',p.allergies],['PATIENT_CHRONIC_DISEASES','Chronic_Diseases',p.chronic],['PATIENT_CURRENT_MEDICATIONS','Current_Medications',p.medications]])for(const val of values){
   // identifiers are fixed internal constants, not interpolated user input.
   await db.query(`INSERT INTO sdc."${table}"("${col}","Patient_ID") VALUES($1::varchar(150),$2::bigint)`,[val,id]);
  }
  await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,'clinic.patient.created','Patient',$1::varchar(512),'إنشاء ملف مريض في عيادة بدون تفعيل تسجيل الدخول',$2::bigint)`,[id,user]);
  await db.query('COMMIT');return {status:'ok',id};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});if(e.code==='23505')return {status:'exists'};throw e;}finally{db.release();}
}
module.exports={parsePatient,list,detail,create};
