'use strict';
// Doctor read models: restrict *every* query by doctor AND active clinic; IDs from
// URLs cannot expand scope. No fabricated patients or health information.
const ID=/^[1-9]\d{0,17}$/;
const validId=v=>ID.test(String(v??''));
const localDate=()=>require('../appointments/service').localNow().date;
const patientPermission=`(EXISTS(SELECT 1 FROM sdc."BOOKING" own WHERE own."Patient_ID"=p."Patient_ID" AND own."Doctor_ID"=$1::bigint AND own."Clinic_ID"=$2::bigint)
 OR EXISTS(SELECT 1 FROM sdc."TREATMENT_PLAN" own WHERE own."Patient_ID"=p."Patient_ID" AND own."Doctor_ID"=$1::bigint AND own."Clinic_ID"=$2::bigint))`;
async function patients(pool,doctorId,clinicId){
 const {rows}=await pool.query(`/* doctor workspace: scoped patients */ SELECT p."Patient_ID"::text AS id,
 u."First_Name"||' '||u."Last_Name" AS name,p."Date_Of_Birth"::text AS dob,
 (SELECT to_char(MAX(b."Appointment_Date"),'YYYY-MM-DD') FROM sdc."BOOKING" b JOIN sdc."VISIT" v ON v."Booking_ID"=b."Booking_ID" WHERE b."Patient_ID"=p."Patient_ID" AND b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint) AS last_visit,
 (SELECT s."Service_Name" FROM sdc."BOOKING" b JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID" WHERE b."Patient_ID"=p."Patient_ID" AND b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint ORDER BY b."Appointment_Date" DESC,b."Booking_ID" DESC LIMIT 1) AS service,
 (SELECT t."Plan_Name" FROM sdc."TREATMENT_PLAN" t WHERE t."Patient_ID"=p."Patient_ID" AND t."Doctor_ID"=$1::bigint AND t."Clinic_ID"=$2::bigint AND t."Plan_Status"='active' ORDER BY t."Start_Date" DESC LIMIT 1) AS active_plan
 FROM sdc."PATIENT" p JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE ${patientPermission}
 ORDER BY u."First_Name",u."Last_Name" LIMIT 500`,[doctorId,clinicId]);
 return rows.map(r=>({...r,initials:r.name.split(/\s+/).slice(0,2).map(s=>s[0]).join(''),age:r.dob?Math.max(0,Number(localDate().slice(0,4))-Number(r.dob.slice(0,4))-(localDate().slice(5)<r.dob.slice(5)?1:0)):null}));
}
async function patientDetails(pool,doctorId,clinicId,patientId){
 if(!validId(patientId))return null;
 const {rows}=await pool.query(`/* doctor workspace: protected patient detail */ SELECT p."Patient_ID"::text AS id,
 p."Date_Of_Birth"::text AS dob,p."Blood_Type" AS blood,p."Health_Notes" AS notes,
 u."First_Name"||' '||u."Last_Name" AS name,u."Phone" AS phone
 FROM sdc."PATIENT" p JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
 WHERE p."Patient_ID"=$3::bigint AND ${patientPermission}`,[doctorId,clinicId,patientId]);
 if(!rows.length)return null;
 const [allergies,chronic,meds,visits,plans]=await Promise.all([
  pool.query(`SELECT "Allergies" AS value FROM sdc."PATIENT_ALLERGIES" WHERE "Patient_ID"=$1::bigint ORDER BY 1`,[patientId]),
  pool.query(`SELECT "Chronic_Diseases" AS value FROM sdc."PATIENT_CHRONIC_DISEASES" WHERE "Patient_ID"=$1::bigint ORDER BY 1`,[patientId]),
  pool.query(`SELECT "Current_Medications" AS value FROM sdc."PATIENT_CURRENT_MEDICATIONS" WHERE "Patient_ID"=$1::bigint ORDER BY 1`,[patientId]),
  pool.query(`SELECT b."Booking_ID"::text AS booking_id, v."Visit_ID"::text AS visit_id, to_char(b."Appointment_Date",'YYYY-MM-DD') AS date,
   b."Booking_Status" AS status,s."Service_Name" AS service,v."Chief_Complaint" AS complaint,v."Report_Approved_At" IS NOT NULL AS approved
   FROM sdc."BOOKING" b LEFT JOIN sdc."VISIT" v ON v."Booking_ID"=b."Booking_ID" JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID"
   WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND b."Patient_ID"=$3::bigint ORDER BY b."Appointment_Date" DESC,b."Start_Time" DESC LIMIT 100`,[doctorId,clinicId,patientId]),
  pool.query(`SELECT t."Plan_ID"::text AS id,t."Plan_Name" AS title,t."Plan_Status" AS status,to_char(t."Start_Date",'YYYY-MM-DD') AS start_date,
   t."Estimated_Cost"::text AS cost,
   COALESCE((SELECT COUNT(*)::int FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=t."Plan_ID"),0) AS total,
   COALESCE((SELECT COUNT(*)::int FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=t."Plan_ID" AND "Stage_Status" IN('completed','done')),0) AS done
   FROM sdc."TREATMENT_PLAN" t WHERE t."Doctor_ID"=$1::bigint AND t."Clinic_ID"=$2::bigint AND t."Patient_ID"=$3::bigint ORDER BY t."Start_Date" DESC LIMIT 25`,[doctorId,clinicId,patientId])
 ]);
 return {...rows[0],allergies:allergies.rows.map(r=>r.value),chronic:chronic.rows.map(r=>r.value),meds:meds.rows.map(r=>r.value),visits:visits.rows,plans:plans.rows};
}
async function followups(pool,doctorId,clinicId){
 const {rows}=await pool.query(`/* doctor workspace: visit-originated followups */ SELECT v."Visit_ID"::text AS id,v."Follow_Up_Type" AS type,
 to_char(v."Suggested_Date",'YYYY-MM-DD') AS date,v."Follow_Up_Notes" AS notes,b."Patient_ID"::text AS patient_id,
 u."First_Name"||' '||u."Last_Name" AS name,t."Plan_Name" AS plan,
 f."Booking_ID"::text AS booked_id,f."Booking_Status" AS booked_status
 FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID"
 JOIN sdc."PATIENT" p ON p."Patient_ID"=b."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
 LEFT JOIN sdc."TREATMENT_PLAN" t ON t."Plan_ID"=b."Plan_ID"
 LEFT JOIN sdc."BOOKING" f ON f."Follow_Up_Of_Visit_ID"=v."Visit_ID" AND f."Clinic_ID"=b."Clinic_ID"
 WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND b."Booking_Status"='completed'
 AND v."Follow_Up_Type" IS NOT NULL AND v."Suggested_Date" IS NOT NULL
 ORDER BY v."Suggested_Date" DESC,v."Visit_ID" DESC LIMIT 200`,[doctorId,clinicId]);
 const now=localDate();return rows.map(r=>({...r,status:r.booked_id&&!['cancelled','rejected'].includes(r.booked_status)?'booked':r.date<now?'overdue':'waiting'}));
}
async function dashboard(pool,doctorId,clinicId){
 const [name,counts,bookings,lab]=await Promise.all([
  pool.query(`SELECT u."First_Name"||' '||u."Last_Name" AS name,c."Clinic_Name" AS clinic FROM sdc."DOCTOR" d JOIN sdc."USER" u ON u."User_ID"=d."User_ID" JOIN sdc."CLINIC" c ON c."Clinic_ID"=$2::bigint WHERE d."Doctor_ID"=$1::bigint`,[doctorId,clinicId]),
  pool.query(`SELECT
   (SELECT COUNT(*)::int FROM sdc."BOOKING" b WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND b."Appointment_Date"=(now() AT TIME ZONE 'Asia/Hebron')::date) AS today,
   (SELECT COUNT(*)::int FROM sdc."BOOKING" b WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND b."Booking_Status"='completed') AS completed,
   (SELECT COUNT(*)::int FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND v."Report_Approved_At" IS NULL AND b."Booking_Status"='completed') AS pending_reports,
   (SELECT COUNT(*)::int FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND v."Follow_Up_Type" IS NOT NULL AND v."Suggested_Date" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sdc."BOOKING" f WHERE f."Follow_Up_Of_Visit_ID"=v."Visit_ID" AND f."Booking_Status" NOT IN('cancelled','rejected'))) AS followups`,[doctorId,clinicId]),
  pool.query(`SELECT b."Booking_ID"::text AS id,b."Booking_Status" AS status,to_char(b."Start_Time",'HH24:MI') AS time,
 u."First_Name"||' '||u."Last_Name" AS name,s."Service_Name" AS service
 FROM sdc."BOOKING" b JOIN sdc."PATIENT" p ON p."Patient_ID"=b."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID" JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID"
 WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND b."Appointment_Date"=(now() AT TIME ZONE 'Asia/Hebron')::date ORDER BY b."Start_Time" LIMIT 15`,[doctorId,clinicId]),
  pool.query(`SELECT COUNT(*)::int AS total FROM sdc."LAB_ORDER" l JOIN sdc."VISIT" v ON v."Visit_ID"=l."Visit_ID" JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" WHERE b."Doctor_ID"=$1::bigint AND b."Clinic_ID"=$2::bigint AND l."Order_Status" NOT IN('received','cancelled','archived')`,[doctorId,clinicId])
 ]);
 return {identity:name.rows[0]||{name:'الطبيب',clinic:'العيادة'},stats:{...counts.rows[0],labs:lab.rows[0].total},today:bookings.rows,date:localDate()};
}
async function treatmentPlans(pool,doctorId,clinicId){
 const {rows}=await pool.query(`/* doctor workspace: treatment plans */ SELECT t."Plan_ID"::text AS id,
 t."Plan_Name" AS title,t."Plan_Status" AS status,to_char(t."Start_Date",'YYYY-MM-DD') AS start_date,
 t."Estimated_Cost"::text AS cost,p."Patient_ID"::text AS patient_id,
 u."First_Name"||' '||u."Last_Name" AS patient_name,
 COALESCE((SELECT COUNT(*)::int FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=t."Plan_ID"),0) AS total,
 COALESCE((SELECT COUNT(*)::int FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=t."Plan_ID" AND "Stage_Status" IN('completed','done')),0) AS done
 FROM sdc."TREATMENT_PLAN" t JOIN sdc."PATIENT" p ON p."Patient_ID"=t."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
 WHERE t."Doctor_ID"=$1::bigint AND t."Clinic_ID"=$2::bigint ORDER BY t."Start_Date" DESC,t."Plan_ID" DESC LIMIT 300`,[doctorId,clinicId]);
 return rows.map(r=>({...r,progress:r.total?Math.round(r.done/r.total*100):0}));
}
async function treatmentPlanDetails(pool,doctorId,clinicId,planId){
 if(!validId(planId))return null;
 const {rows}=await pool.query(`/* doctor workspace: plan read scoped */ SELECT t."Plan_ID"::text AS id,t."Plan_Name" AS title,
 t."Plan_Status" AS status,to_char(t."Start_Date",'YYYY-MM-DD') AS start_date,t."Estimated_Cost"::text AS cost,
 t."Notes" AS notes,t."Patient_ID"::text AS patient_id,
 u."First_Name"||' '||u."Last_Name" AS patient_name
 FROM sdc."TREATMENT_PLAN" t JOIN sdc."PATIENT" p ON p."Patient_ID"=t."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
 WHERE t."Doctor_ID"=$1::bigint AND t."Clinic_ID"=$2::bigint AND t."Plan_ID"=$3::bigint`,[doctorId,clinicId,planId]);
 if(!rows.length)return null;
 const {rows:stages}=await pool.query(`SELECT "Stage_ID"::text AS id,"Stage_Order" AS ordering,"Tooth_Number" AS tooth,"Description" AS description,"Stage_Status" AS status
 FROM sdc."TREATMENT_STAGE" WHERE "Plan_ID"=$1::bigint ORDER BY "Stage_Order"`,[planId]);
 const done=stages.filter(s=>['completed','done'].includes(s.status)).length;
 return {...rows[0],stages,progress:stages.length?Math.round(done/stages.length*100):0,done};
}
module.exports={validId,patients,patientDetails,followups,dashboard,treatmentPlans,treatmentPlanDetails};
