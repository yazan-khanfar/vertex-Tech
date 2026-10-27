'use strict';
const {num,dateValid,hm}=require('./service');
const WEEKDAYS=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
async function doctors(db,clinic){const r=await db.query(`SELECT w."Doctor_ID"::text AS id,c."Manager_Doctor_ID"=w."Doctor_ID" AS manager,to_char(w."Start_Date",'YYYY-MM-DD') AS start_date,u."First_Name"||' '||u."Last_Name" AS name,
 COALESCE((SELECT string_agg(DISTINCT s."Name_AR",'، ' ORDER BY s."Name_AR")
 FROM sdc."HAS_SPECIALTY" hs JOIN sdc."SPECIALTY" s ON s."Specialty_ID"=hs."Specialty_ID"
 WHERE hs."Doctor_ID"=w."Doctor_ID" AND s."Is_Active"),'طب الأسنان') AS specialties
 FROM sdc."WORKS_AT" w JOIN sdc."DOCTOR" d ON d."Doctor_ID"=w."Doctor_ID"
 JOIN sdc."USER" u USING("User_ID") JOIN sdc."CLINIC" c ON c."Clinic_ID"=w."Clinic_ID"
 WHERE w."Clinic_ID"=$1::bigint AND w."Membership_Status"='active'
 AND d."License_Status"='verified' AND u."Account_Status"='active'
 ORDER BY name`,[clinic]);return r.rows;}
async function read(db,clinic,doctor){if(!num(doctor)||!num(clinic))return null;
 const ds=await doctors(db,clinic);const person=ds.find(d=>d.id===doctor);if(!person)return null;
 const [periods,absences,services]=await Promise.all([
 db.query(`SELECT "Day_Of_Week" AS day,to_char("Start_Time",'HH24:MI') AS start,CASE WHEN "End_Time"=TIME '24:00' THEN '24:00' ELSE to_char("End_Time",'HH24:MI') END AS end,"Is_Active" AS active FROM sdc."DOCTOR_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint ORDER BY "Day_Of_Week","Start_Time"`,[clinic,doctor]),
 db.query(`SELECT "Absence_ID"::text AS id,to_char("From_Date",'YYYY-MM-DD') AS start,to_char("To_Date",'YYYY-MM-DD') AS end,"Reason" AS reason FROM sdc."DOCTOR_ABSENCES" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint ORDER BY "From_Date" DESC LIMIT 100`,[clinic,doctor]),
 db.query(`SELECT s."Service_Name" AS name,o."Price"::text AS price,o."Duration_Minutes" AS duration FROM sdc."PROVIDES" p JOIN sdc."SERVICE" s ON s."Service_ID"=p."Service_ID" JOIN sdc."OFFERS" o ON o."Clinic_ID"=p."Clinic_ID" AND o."Service_ID"=p."Service_ID" WHERE p."Clinic_ID"=$1::bigint AND p."Doctor_ID"=$2::bigint ORDER BY s."Service_Name"`,[clinic,doctor])
 ]);return {person,periods:periods.rows,absences:absences.rows,services:services.rows};}
function validHour(value,allowMidnight=false){
 if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)&&!(allowMidnight&&value==='24:00'))return false;
 return hm(value)>=0 && hm(value)<=(allowMidnight?1440:1439);
}
function validPeriod(day,start,end){
 return Number.isInteger(day)&&day>=0&&day<=6&&validHour(start)&&validHour(end,true)&&hm(end)>hm(start);
}
async function save(pool,clinic,doctor,userId,b){
 if(!num(clinic)||!num(doctor))return {status:'invalid'};
 const action=String(b.action||'');
 if(!['add_period','update_period','remove_period','add_absence','remove_absence'].includes(action))return {status:'invalid'};
 const day=Number(b.day),start=String(b.start||''),end=b.end_of_day==='on'?'24:00':String(b.end||'');
 const periodAction=action==='add_period'||action==='update_period'||action==='remove_period';
 if(periodAction&&!validPeriod(day,start,end))return {status:'invalid'};
 const oldDay=Number(b.original_day),oldStart=String(b.original_start||''),oldEnd=String(b.original_end||'');
 if(action==='update_period'&&!validPeriod(oldDay,oldStart,oldEnd))return {status:'invalid'};
 const active=b.active===undefined||b.active==='true';
 if(action==='update_period'&&!['true','false'].includes(b.active))return {status:'invalid'};
 if(action==='add_absence'&&(!dateValid(b.from_date)||!dateValid(b.to_date)||b.to_date<b.from_date||!String(b.reason||'').trim()||String(b.reason).length>2000))return {status:'invalid'};
 if(action==='remove_absence'&&!num(b.absence_id))return {status:'invalid'};
 const db=await pool.connect();try{
  await db.query('BEGIN');
  await db.query("SELECT set_config('sdc.user_id',$1,true)",[userId]);
  // Lock the doctor before schedule edits; appointments use this same lock.
  await db.query('SELECT "Doctor_ID" FROM sdc."DOCTOR" WHERE "Doctor_ID"=$1::bigint FOR UPDATE',[doctor]);
  const membership=await db.query(`SELECT 1 FROM sdc."WORKS_AT" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Membership_Status"='active' FOR UPDATE`,[clinic,doctor]);
  if(!membership.rowCount){await db.query('ROLLBACK');return {status:'forbidden'};}
  if(action==='update_period'){
   const old=await db.query(`SELECT 1 FROM sdc."DOCTOR_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Day_Of_Week"=$3::smallint AND "Start_Time"=$4::time AND "End_Time"=$5::time FOR UPDATE`,[clinic,doctor,oldDay,oldStart,oldEnd]);
   if(!old.rowCount){await db.query('ROLLBACK');return {status:'stale'};}
  }
  // Check all active hours for this doctor, including those in other clinics.
  if((action==='add_period'||action==='update_period')&&active){
   const overlaps=await db.query(`SELECT 1 FROM sdc."DOCTOR_WORKING_HOURS" h WHERE h."Doctor_ID"=$1::bigint AND h."Day_Of_Week"=$2::smallint AND h."Is_Active"=true AND h."Start_Time"<$3::time AND h."End_Time">$4::time AND NOT ($5::boolean AND h."Clinic_ID"=$6::bigint AND h."Day_Of_Week"=$7::smallint AND h."Start_Time"=$8::time AND h."End_Time"=$9::time) LIMIT 1`,[doctor,day,end,start,action==='update_period',clinic,action==='update_period'?oldDay:day,action==='update_period'?oldStart:start,action==='update_period'?oldEnd:end]);
   if(overlaps.rowCount){await db.query('ROLLBACK');return {status:'conflict'};}
  }
  if(action==='update_period'){
   // Preserve existing pending/confirmed bookings before allowing a shift to change.
   const bookings=await db.query(`SELECT 1 FROM sdc."BOOKING" b WHERE b."Clinic_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint AND b."Appointment_Date">=CURRENT_DATE AND b."Booking_Status" IN ('pending','confirmed','in_progress') AND EXTRACT(DOW FROM b."Appointment_Date") IN ($3::smallint,$4::smallint) AND NOT (
    ($5::boolean AND EXTRACT(DOW FROM b."Appointment_Date")=$4::smallint AND b."Start_Time">=$6::time AND b."Start_Time"+make_interval(mins=>b."Duration_Minutes_Snapshot")<=$7::time)
    OR EXISTS (SELECT 1 FROM sdc."DOCTOR_WORKING_HOURS" h WHERE h."Clinic_ID"=$1::bigint AND h."Doctor_ID"=$2::bigint AND h."Is_Active"=true AND NOT (h."Day_Of_Week"=$3::smallint AND h."Start_Time"=$8::time AND h."End_Time"=$9::time) AND h."Day_Of_Week"=EXTRACT(DOW FROM b."Appointment_Date") AND b."Start_Time">=h."Start_Time" AND b."Start_Time"+make_interval(mins=>b."Duration_Minutes_Snapshot")<=h."End_Time")
   ) LIMIT 1`,[clinic,doctor,oldDay,day,active,start,end,oldStart,oldEnd]);
   if(bookings.rowCount){await db.query('ROLLBACK');return {status:'bookings_affected'};}
   const updated=await db.query(`UPDATE sdc."DOCTOR_WORKING_HOURS" SET "Day_Of_Week"=$6::smallint,"Start_Time"=$7::time,"End_Time"=$8::time,"Is_Active"=$9::boolean WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Day_Of_Week"=$3::smallint AND "Start_Time"=$4::time AND "End_Time"=$5::time`,[clinic,doctor,oldDay,oldStart,oldEnd,day,start,end,active]);
   if(!updated.rowCount){await db.query('ROLLBACK');return {status:'stale'};}
  }
  // Removing a shift must not strand existing bookings. Another active shift on
  // that weekday may cover them; only the removed shift is excluded.
  if(action==='remove_period'){
   const old=await db.query(`SELECT 1 FROM sdc."DOCTOR_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Day_Of_Week"=$3::smallint AND "Start_Time"=$4::time AND "End_Time"=$5::time FOR UPDATE`,[clinic,doctor,day,start,end]);
   if(!old.rowCount){await db.query('ROLLBACK');return {status:'stale'};}
   const conflict=await db.query(`SELECT 1 FROM sdc."BOOKING" b
    WHERE b."Clinic_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint
    AND b."Appointment_Date">=CURRENT_DATE
    AND b."Booking_Status" IN ('pending','confirmed','in_progress')
    AND EXTRACT(DOW FROM b."Appointment_Date")=$3::smallint
    AND NOT EXISTS (
      SELECT 1 FROM sdc."DOCTOR_WORKING_HOURS" h
      WHERE h."Clinic_ID"=$1::bigint AND h."Doctor_ID"=$2::bigint
      AND h."Is_Active"=true AND h."Day_Of_Week"=$3::smallint
      AND NOT (h."Start_Time"=$4::time AND h."End_Time"=$5::time)
      AND b."Start_Time">=h."Start_Time"
      AND b."Start_Time"+make_interval(mins=>b."Duration_Minutes_Snapshot")<=h."End_Time"
    ) LIMIT 1`,[clinic,doctor,day,start,end]);
   if(conflict.rowCount){await db.query('ROLLBACK');return {status:'bookings_affected'};}
  }
  // An absence is specific to this clinic; never let it silently cancel booked
  // care. The doctor is locked above, as in the appointment booking workflow.
  if(action==='add_absence'){
   const conflict=await db.query(`SELECT 1 FROM sdc."BOOKING" WHERE "Clinic_ID"=$1::bigint
    AND "Doctor_ID"=$2::bigint AND "Appointment_Date" BETWEEN $3::date AND $4::date
    AND "Appointment_Date">=CURRENT_DATE
    AND "Booking_Status" IN ('pending','confirmed','in_progress') LIMIT 1`,[clinic,doctor,b.from_date,b.to_date]);
   if(conflict.rowCount){await db.query('ROLLBACK');return {status:'bookings_affected'};}
   const overlap=await db.query(`SELECT 1 FROM sdc."DOCTOR_ABSENCES"
    WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint
    AND "From_Date"<=$4::date AND "To_Date">=$3::date LIMIT 1`,[clinic,doctor,b.from_date,b.to_date]);
   if(overlap.rowCount){await db.query('ROLLBACK');return {status:'absence_overlap'};}
  }
  if(action==='add_period')await db.query(`INSERT INTO sdc."DOCTOR_WORKING_HOURS"("Day_Of_Week","Start_Time","End_Time","Is_Active","Clinic_ID","Doctor_ID") VALUES($1::smallint,$2::time,$3::time,true,$4::bigint,$5::bigint)`,[day,start,end,clinic,doctor]);
  if(action==='remove_period')await db.query(`DELETE FROM sdc."DOCTOR_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Day_Of_Week"=$3::smallint AND "Start_Time"=$4::time AND "End_Time"=$5::time`,[clinic,doctor,day,start,end]);
  if(action==='add_absence')await db.query(`INSERT INTO sdc."DOCTOR_ABSENCES"("From_Date","To_Date","Reason","Clinic_ID","Doctor_ID") VALUES($1::date,$2::date,$3::text,$4::bigint,$5::bigint)`,[b.from_date,b.to_date,b.reason.trim(),clinic,doctor]);
  if(action==='remove_absence')await db.query(`DELETE FROM sdc."DOCTOR_ABSENCES" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Absence_ID"=$3::bigint`,[clinic,doctor,b.absence_id]);
  await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,$1::varchar(150),'Doctor',$2::varchar(512),'تحديث جدول الطبيب أو الغياب',$3::bigint)`,[`doctor.schedule.${action}`,doctor,userId]);
  await db.query('COMMIT');return {status:'ok'};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});
  if(['23505','23514','23P01'].includes(e.code))return {status:'conflict'};
  throw e;
 }finally{db.release();}
}

module.exports={doctors,read,save,WEEKDAYS};
