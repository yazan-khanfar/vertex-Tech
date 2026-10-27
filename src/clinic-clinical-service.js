'use strict';
// Clinic-facing clinical read models. Clinical modifications remain physician-only.
const validId=value=>/^[1-9]\d{0,17}$/.test(String(value??''));
const labelStatus=s=>({active:'نشطة',paused:'متوقفة',completed:'مكتملة',draft:'مسودة',cancelled:'ملغاة',pending:'بانتظار التنفيذ',in_progress:'جارٍ',done:'مكتملة',planned:'مخططة'})[s]||String(s||'غير محدد');
const safeRate=(done,total)=>total?Math.round(done/total*100):0;
function resolveRecall(visit,now){
 const date=String(visit.suggested_date||'');
 if(visit.follow_booking_id)return ['cancelled','rejected'].includes(visit.follow_booking_status)?'cancelled':'booked';
 return date && date<now?'overdue':'waiting';
}
async function listPlans(pool,clinicId){
 const {rows}=await pool.query(`/* clinic clinical: plans */
 SELECT p."Plan_ID"::text AS id,p."Plan_Name" AS title,p."Plan_Status" AS status,
 p."Doctor_ID"::text AS doctor_id,p."Patient_ID"::text AS patient_id,
 u."First_Name"||' '||u."Last_Name" AS patient_name,du."First_Name"||' '||du."Last_Name" AS doctor_name,
 COALESCE(st.total_stages,0)::int AS stages,COALESCE(st.done_stages,0)::int AS done,
 nxt.next_date
 FROM sdc."TREATMENT_PLAN" p
 JOIN sdc."PATIENT" pat ON pat."Patient_ID"=p."Patient_ID"
 JOIN sdc."USER" u ON u."User_ID"=pat."User_ID"
 JOIN sdc."DOCTOR" d ON d."Doctor_ID"=p."Doctor_ID"
 JOIN sdc."USER" du ON du."User_ID"=d."User_ID"
 LEFT JOIN LATERAL(SELECT COUNT(*)::int AS total_stages,COUNT(*) FILTER(WHERE "Stage_Status" IN('completed','done'))::int AS done_stages FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=p."Plan_ID") st ON true
 LEFT JOIN LATERAL(SELECT to_char(b."Appointment_Date",'YYYY-MM-DD') AS next_date
 FROM sdc."BOOKING" b WHERE b."Clinic_ID"=p."Clinic_ID" AND b."Plan_ID"=p."Plan_ID"
 AND b."Booking_Status" IN('pending','confirmed') AND b."Appointment_Date">=(now() AT TIME ZONE 'Asia/Hebron')::date
 ORDER BY b."Appointment_Date",b."Start_Time" LIMIT 1) nxt ON true
 WHERE p."Clinic_ID"=$1::bigint ORDER BY p."Start_Date" DESC,p."Plan_ID" DESC LIMIT 300`,[clinicId]);
 return rows.map(r=>({...r,progress:safeRate(r.done,r.stages),status_label:labelStatus(r.status)}));
}
async function planDetails(pool,clinicId,planId){
 if(!validId(planId))return null;
 const {rows}=await pool.query(`/* clinic clinical: plan detail */
 SELECT p."Plan_ID"::text AS id,p."Plan_Name" AS title,p."Plan_Status" AS status,
 to_char(p."Start_Date",'YYYY-MM-DD') AS start_date,p."Estimated_Cost"::text AS cost,
 p."Notes" AS notes,p."Doctor_ID"::text AS doctor_id,p."Patient_ID"::text AS patient_id,
 u."First_Name"||' '||u."Last_Name" AS patient_name,du."First_Name"||' '||du."Last_Name" AS doctor_name
 FROM sdc."TREATMENT_PLAN" p JOIN sdc."PATIENT" pat ON pat."Patient_ID"=p."Patient_ID"
 JOIN sdc."USER" u ON u."User_ID"=pat."User_ID" JOIN sdc."DOCTOR" d ON d."Doctor_ID"=p."Doctor_ID"
 JOIN sdc."USER" du ON du."User_ID"=d."User_ID"
 WHERE p."Clinic_ID"=$1::bigint AND p."Plan_ID"=$2::bigint`,[clinicId,planId]);
 if(!rows[0])return null;
 const [stages,appointments]=await Promise.all([
 pool.query(`/* clinic clinical: stages */ SELECT "Stage_Order" AS ord,"Tooth_Number" AS tooth,"Description" AS description,"Stage_Status" AS status FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=$1::bigint ORDER BY "Stage_Order"`,[planId]),
 pool.query(`/* clinic clinical: next plan booking */ SELECT b."Booking_ID"::text AS id,to_char(b."Appointment_Date",'YYYY-MM-DD') AS date,to_char(b."Start_Time",'HH24:MI') AS time FROM sdc."BOOKING" b WHERE b."Clinic_ID"=$1::bigint AND b."Plan_ID"=$2::bigint AND b."Booking_Status" IN('pending','confirmed') AND b."Appointment_Date">=(now() AT TIME ZONE 'Asia/Hebron')::date ORDER BY b."Appointment_Date",b."Start_Time" LIMIT 1`,[clinicId,planId])]);
 const done=stages.rows.filter(s=>['completed','done'].includes(s.status)).length;
 return {...rows[0],stages:stages.rows,progress:safeRate(done,stages.rows.length),status_label:labelStatus(rows[0].status),next:appointments.rows[0]||null};
}
async function listRecalls(pool,clinicId,now){
 const {rows}=await pool.query(`/* clinic clinical: followups */ SELECT
 v."Visit_ID"::text AS id, v."Follow_Up_Type" AS type,v."Follow_Up_Notes" AS notes,
 to_char(v."Suggested_Date",'YYYY-MM-DD') AS suggested_date,
 b."Patient_ID"::text AS patient_id,b."Doctor_ID"::text AS doctor_id,b."Plan_ID"::text AS plan_id,
 p."First_Name"||' '||p."Last_Name" AS patient_name,d."First_Name"||' '||d."Last_Name" AS doctor_name,
 f."Booking_ID"::text AS follow_booking_id,f."Booking_Status" AS follow_booking_status,
 to_char(f."Appointment_Date",'YYYY-MM-DD') AS booked_date,to_char(f."Start_Time",'HH24:MI') AS booked_time
 FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID"
 JOIN sdc."PATIENT" pa ON pa."Patient_ID"=b."Patient_ID" JOIN sdc."USER" p ON p."User_ID"=pa."User_ID"
 JOIN sdc."DOCTOR" doc ON doc."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" d ON d."User_ID"=doc."User_ID"
 LEFT JOIN sdc."BOOKING" f ON f."Follow_Up_Of_Visit_ID"=v."Visit_ID" AND f."Clinic_ID"=b."Clinic_ID"
 WHERE b."Clinic_ID"=$1::bigint AND b."Booking_Status"='completed' AND v."Follow_Up_Type" IS NOT NULL AND v."Suggested_Date" IS NOT NULL
 ORDER BY v."Suggested_Date" DESC,v."Visit_ID" DESC LIMIT 300`,[clinicId]);
 return rows.map(r=>({...r,status:resolveRecall(r,now)}));
}
async function completedVisit(pool,clinicId,visitId){
 if(!validId(visitId))return null;
 const {rows}=await pool.query(`/* clinic clinical: checkout */ SELECT
 v."Visit_ID"::text AS id,v."Chief_Complaint" AS complaint,v."Examination_Notes" AS examination,
 v."Visit_Status" AS visit_status,v."Follow_Up_Type" AS follow_type,v."Follow_Up_Notes" AS follow_notes,
 to_char(v."Suggested_Date",'YYYY-MM-DD') AS follow_date,v."Report_Approved_At" IS NOT NULL AS approved,
 v."Recommendations" AS recommendations,v."Approved_Report_File_Reference" AS report_ref,
 b."Booking_ID"::text AS booking_id,b."Patient_ID"::text AS patient_id,b."Doctor_ID"::text AS doctor_id,
 b."Duration_Minutes_Snapshot" AS duration,b."Service_Price_Snapshot"::text AS price,
 to_char(b."Appointment_Date",'YYYY-MM-DD') AS date,to_char(b."Start_Time",'HH24:MI') AS time,
 b."Booking_Status" AS booking_status,
 p."First_Name"||' '||p."Last_Name" AS patient_name, d."First_Name"||' '||d."Last_Name" AS doctor_name,
 s."Service_Name" AS service_name,
 (SELECT "Booking_ID"::text FROM sdc."BOOKING" f WHERE f."Follow_Up_Of_Visit_ID"=v."Visit_ID" AND f."Clinic_ID"=b."Clinic_ID" AND f."Booking_Status" NOT IN('cancelled','rejected') LIMIT 1) AS follow_booking_id
 FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID"
 JOIN sdc."PATIENT" pat ON pat."Patient_ID"=b."Patient_ID" JOIN sdc."USER" p ON p."User_ID"=pat."User_ID"
 JOIN sdc."DOCTOR" doc ON doc."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" d ON d."User_ID"=doc."User_ID"
 JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID"
 WHERE b."Clinic_ID"=$1::bigint AND v."Visit_ID"=$2::bigint AND b."Booking_Status"='completed'`,[clinicId,visitId]);
 return rows[0]||null;
}
async function reportDetails(pool,clinicId,visitId){
 const visit=await completedVisit(pool,clinicId,visitId);
 if(!visit || !visit.approved || !visit.report_ref)return null;
 const [diagnoses,procedures,medications,files]=await Promise.all([
 pool.query(`SELECT "Tooth_Number" AS tooth,"Diagnosis_Text" AS description FROM sdc."VISIT_DIAGNOSES" WHERE "Visit_ID"=$1::bigint ORDER BY "Diagnosis_ID"`,[visitId]),
 pool.query(`SELECT s."Service_Name" AS name,pr."Notes" AS notes,pr."Tooth_Number" AS tooth FROM sdc."PROCEDURE" pr JOIN sdc."SERVICE" s ON s."Service_ID"=pr."Service_ID" WHERE pr."Visit_ID"=$1::bigint AND pr."Procedure_Status" NOT IN('cancelled') ORDER BY pr."Procedure_ID"`,[visitId]),
 pool.query(`SELECT m."Medication_Name" AS name,m."Dosage" AS dosage,m."Frequency" AS frequency,m."Duration" AS duration FROM sdc."PRESCRIPTION" p JOIN sdc."PRESCRIPTION_MEDICATIONS" m ON m."Prescription_ID"=p."Prescription_ID" WHERE p."Visit_ID"=$1::bigint AND p."Prescription_Status"='issued' ORDER BY m."Medication_ID"`,[visitId]),
 pool.query(`SELECT "File_Name" AS name,"Description" AS description FROM sdc."VISIT_VISIT_FILES" WHERE "Visit_ID"=$1::bigint AND "Included_In_Report"=true ORDER BY "File_ID"`,[visitId])
 ]);
 return {...visit,diagnoses:diagnoses.rows,procedures:procedures.rows,medications:medications.rows,files:files.rows};
}
module.exports={validId,labelStatus,safeRate,resolveRecall,listPlans,planDetails,listRecalls,completedVisit,reportDetails};
