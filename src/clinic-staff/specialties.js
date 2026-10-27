'use strict';
async function list(pool,clinic){
 const r=await pool.query(`SELECT s."Specialty_ID"::text AS id,s."Name_AR" AS name,
 array_agg(DISTINCT u."First_Name"||' '||u."Last_Name" ORDER BY u."First_Name"||' '||u."Last_Name") AS doctors,
 MIN(d."Doctor_ID")::text AS doctor_id
 FROM sdc."WORKS_AT" w JOIN sdc."DOCTOR" d ON d."Doctor_ID"=w."Doctor_ID"
 JOIN sdc."USER" u ON u."User_ID"=d."User_ID" JOIN sdc."HAS_SPECIALTY" h ON h."Doctor_ID"=d."Doctor_ID"
 JOIN sdc."SPECIALTY" s ON s."Specialty_ID"=h."Specialty_ID"
 WHERE w."Clinic_ID"=$1::bigint AND w."Membership_Status"='active' AND w."Start_Date"<=CURRENT_DATE AND s."Is_Active"=true
 AND d."License_Status"='verified' AND u."Account_Status"='active'
 GROUP BY s."Specialty_ID",s."Name_AR" ORDER BY s."Name_AR"`,[clinic]);
 return r.rows;
}
module.exports={list};
