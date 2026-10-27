'use strict';
// A public directory for authenticated patients: never include unapproved clinics,
// unverified doctors, inactive accounts or unavailable services.
const numericId = value => /^[1-9]\d{0,17}$/.test(String(value||'')) ? String(value) : null;
const BASE=`FROM sdc."WORKS_AT" w
 JOIN sdc."CLINIC" c ON c."Clinic_ID"=w."Clinic_ID"
 JOIN sdc."DOCTOR" d ON d."Doctor_ID"=w."Doctor_ID"
 JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 WHERE c."Approval_Status"='approved' AND c."Clinic_Status"='active'
 AND w."Membership_Status"='active' AND d."License_Status"='verified'
 AND u."Account_Status"='active' AND u."Login_Enabled"=true`;
async function services(db){
 const result=await db.query(`SELECT DISTINCT s."Service_ID"::text AS id,s."Service_Name" AS name
 FROM sdc."SERVICE" s JOIN sdc."OFFERS" o ON o."Service_ID"=s."Service_ID"
 JOIN sdc."CLINIC" c ON c."Clinic_ID"=o."Clinic_ID"
 WHERE o."Is_Available" AND c."Approval_Status"='approved' AND c."Clinic_Status"='active'
 ORDER BY name LIMIT 300`);
 return result.rows;
}
async function clinics(db){
 const result=await db.query(`SELECT c."Clinic_ID"::text AS id,c."Clinic_Name" AS name,c."City" AS city,
 c."Area" AS area,c."Address_Text" AS address,c."Latitude"::text AS latitude,
 c."Longitude"::text AS longitude,c."Online_Booking_Enabled" AS online_booking,
 COUNT(DISTINCT w."Doctor_ID") FILTER(WHERE w."Membership_Status"='active'
 AND d."License_Status"='verified' AND u."Account_Status"='active' AND u."Login_Enabled")::int AS doctor_count,
 (SELECT COUNT(*)::int FROM sdc."OFFERS" o WHERE o."Clinic_ID"=c."Clinic_ID" AND o."Is_Available") AS service_count,
 (SELECT COALESCE(string_agg(o."Service_ID"::text,','),'') FROM sdc."OFFERS" o WHERE o."Clinic_ID"=c."Clinic_ID" AND o."Is_Available") AS service_ids
 FROM sdc."CLINIC" c LEFT JOIN sdc."WORKS_AT" w ON w."Clinic_ID"=c."Clinic_ID"
 LEFT JOIN sdc."DOCTOR" d ON d."Doctor_ID"=w."Doctor_ID"
 LEFT JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 WHERE c."Approval_Status"='approved' AND c."Clinic_Status"='active'
 GROUP BY c."Clinic_ID" ORDER BY c."Clinic_Name" LIMIT 250`);
 return result.rows;
}
async function doctors(db,clinicId=null){
 const result=await db.query(`SELECT w."Clinic_ID"::text AS clinic_id,c."Clinic_Name" AS clinic_name,
 w."Doctor_ID"::text AS id, u."First_Name"||' '||u."Last_Name" AS name,
 d."Years_Of_Experience" AS experience,d."Bio" AS bio,
 COALESCE((SELECT string_agg(DISTINCT s."Name_AR",'، ' ORDER BY s."Name_AR")
 FROM sdc."HAS_SPECIALTY" h JOIN sdc."SPECIALTY" s ON s."Specialty_ID"=h."Specialty_ID"
 WHERE h."Doctor_ID"=d."Doctor_ID" AND s."Is_Active"), 'طب الأسنان') AS specialties,
 EXISTS(SELECT 1 FROM sdc."PROVIDES" p JOIN sdc."OFFERS" o ON o."Clinic_ID"=p."Clinic_ID" AND o."Service_ID"=p."Service_ID"
 WHERE p."Clinic_ID"=w."Clinic_ID" AND p."Doctor_ID"=w."Doctor_ID" AND o."Is_Available") AS bookable
 ${BASE} AND ($1::bigint IS NULL OR w."Clinic_ID"=$1::bigint)
 ORDER BY u."First_Name",u."Last_Name",c."Clinic_Name" LIMIT 400`,[clinicId]);
 return result.rows;
}
async function clinicDetails(db,id){
 if(!numericId(id))return null;
 const r=await db.query(`SELECT "Clinic_ID"::text AS id,"Clinic_Name" AS name,"City" AS city,"Area" AS area,
 "Address_Text" AS address,"Description" AS description,"Clinic_Phone" AS phone,"Clinic_Email" AS email,
 "Latitude"::text AS latitude,"Longitude"::text AS longitude,"Online_Booking_Enabled" AS online_booking
 FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active'`,[id]);
 if(!r.rows[0])return null;
 const [people,hours,services]=await Promise.all([
  doctors(db,id),
  db.query(`SELECT "Day_Of_Week" AS day,to_char("Start_Time",'HH24:MI') AS start,CASE WHEN "End_Time"=TIME '24:00' THEN '24:00' ELSE to_char("End_Time",'HH24:MI') END AS finish
  FROM sdc."CLINIC_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint ORDER BY "Day_Of_Week","Start_Time"`,[id]),
  db.query(`SELECT o."Service_ID"::text AS id,s."Service_Name" AS name,o."Price"::text AS price,o."Duration_Minutes" AS duration
  FROM sdc."OFFERS" o JOIN sdc."SERVICE" s USING("Service_ID") WHERE o."Clinic_ID"=$1::bigint AND o."Is_Available" ORDER BY s."Service_Name"`,[id])
 ]);
 return {clinic:r.rows[0],doctors:people,hours:hours.rows,services:services.rows};
}
async function doctorDetails(db,doctorId,clinicId=null){
 if(!numericId(doctorId)||(clinicId&&!numericId(clinicId)))return null;
 const people=await doctors(db,clinicId);
 const doctor=people.find(r=>r.id===String(doctorId));if(!doctor)return null;
 const [services,hours]=await Promise.all([
  db.query(`SELECT o."Service_ID"::text AS id,s."Service_Name" AS name,o."Price"::text AS price,o."Duration_Minutes" AS duration
  FROM sdc."PROVIDES" p JOIN sdc."OFFERS" o ON o."Service_ID"=p."Service_ID" AND o."Clinic_ID"=p."Clinic_ID"
  JOIN sdc."SERVICE" s ON s."Service_ID"=p."Service_ID"
  WHERE p."Clinic_ID"=$1::bigint AND p."Doctor_ID"=$2::bigint AND o."Is_Available" ORDER BY s."Service_Name"`,[doctor.clinic_id,doctor.id]),
  db.query(`SELECT "Day_Of_Week" AS day,to_char("Start_Time",'HH24:MI') AS start,to_char("End_Time",'HH24:MI') AS finish
  FROM sdc."DOCTOR_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Is_Active" ORDER BY "Day_Of_Week","Start_Time"`,[doctor.clinic_id,doctor.id])
 ]);
 return {doctor,services:services.rows,hours:hours.rows};
}
module.exports={numericId,services,clinics,doctors,clinicDetails,doctorDetails};
