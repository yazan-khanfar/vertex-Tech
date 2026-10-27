'use strict';
const NUM=/^[1-9]\d{0,17}$/;
const mail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;
const date=/^\d{4}-\d\d-\d\d$/;
const hhmm=/^([01]\d|2[0-3]):[0-5]\d$/;
const validDate=value=>{
 if(!date.test(value))return false;
 const parsed=new Date(value+'T12:00:00Z');
 return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};
function clinicId(req){
 const id=String(req.sdcSession?.clinicId||'');
 return NUM.test(id)&&req.sdcActor?.role==='doctor'&&req.sdcClinics?.some(c=>c.id===id&&c.manager===true)?id:null;
}
async function readProfile(pool,id){
 const [c,h,e,d,stats]=await Promise.all([
  pool.query('SELECT * FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"=\'approved\' AND "Clinic_Status"=\'active\'',[id]),
  pool.query('SELECT "Day_Of_Week",to_char("Start_Time",\'HH24:MI\') AS start,CASE WHEN "End_Time" = TIME \'24:00\' THEN \'24:00\' ELSE to_char("End_Time",\'HH24:MI\') END AS finish FROM sdc."CLINIC_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint ORDER BY "Day_Of_Week","Start_Time"',[id]),
  pool.query('SELECT "Exception_ID",to_char("Exception_Date",\'YYYY-MM-DD\') AS date,"Exception_Type",to_char("Start_Time",\'HH24:MI\') AS start,to_char("End_Time",\'HH24:MI\') AS finish,"Reason" FROM sdc."CLINIC_WORKING_EXCEPTIONS" WHERE "Clinic_ID"=$1::bigint ORDER BY "Exception_Date","Start_Time"',[id]),
  pool.query('SELECT "Document_ID","Document_Type","File_Name","Version_Number","Uploaded_At","Review_Status","Is_Current" FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1::bigint ORDER BY "Document_Type","Version_Number" DESC',[id]),
  pool.query(`SELECT (SELECT COUNT(*) FROM sdc."WORKS_AT" WHERE "Clinic_ID"=$1::bigint AND "Membership_Status"='active') AS doctors,(SELECT COUNT(*) FROM sdc."OFFERS" WHERE "Clinic_ID"=$1::bigint) AS services,(SELECT COUNT(*) FROM sdc."BOOKING" WHERE "Clinic_ID"=$1::bigint AND "Appointment_Date"=CURRENT_DATE) AS appointments`,[id])
 ]);
 return c.rows[0]?{clinic:c.rows[0],hours:h.rows,exceptions:e.rows,documents:d.rows,stats:stats.rows[0]}:null;
}
function checkProfile(b){
 const o={name:String(b.name||'').trim(),phone:String(b.phone||'').trim(),email:String(b.email||'').trim().toLowerCase(),city:String(b.city||'').trim(),area:String(b.area||'').trim(),address:String(b.address||'').trim(),description:String(b.description||'').trim(),lat:Number(b.latitude),lng:Number(b.longitude)};
 if(!text(o.name,150)||!text(o.phone,30)||!text(o.email,254)||!mail.test(o.email)||!text(o.city,150)||!text(o.area,150)||!text(o.address,2000)||o.description.length>4000||!text(b.latitude,24)||!text(b.longitude,24)||!Number.isFinite(o.lat)||!Number.isFinite(o.lng)||o.lat < -90||o.lat>90||o.lng < -180||o.lng>180)return null;
 return o;
}
function checkHours(raw){
 let a;try{a=JSON.parse(raw);}catch{return null;}
 if(!Array.isArray(a)||a.length>35)return null;
 const seen=new Set(),periods={};
 for(const r of a){
  // PostgreSQL TIME supports 24:00 as the end-of-day boundary. Accept it
  // only for a full-day (00:00–24:00) row, never for an overnight period.
  const fullDay=r.start==='00:00'&&r.end==='24:00';
  if(!Number.isInteger(r.day)||r.day<0||r.day>6||!hhmm.test(r.start)||!(hhmm.test(r.end)||fullDay)||r.start>=r.end)return null;
  const key=r.day+'|'+r.start;if(seen.has(key))return null;seen.add(key);(periods[r.day]||=([])).push(r);
 }
 for(const list of Object.values(periods)){list.sort((x,y)=>x.start.localeCompare(y.start));for(let i=1;i<list.length;i++)if(list[i].start<list[i-1].end)return null;}
 return a;
}
function checkExceptions(raw){
 let a;try{a=JSON.parse(raw);}catch{return null;}
 if(!Array.isArray(a)||a.length>80)return null;
 const days=new Map();
 for(const r of a){
  if(!validDate(r.date)||!['closed','custom_hours'].includes(r.type)||!text(r.reason,2000))return null;
  if(r.type==='custom_hours'&&(!hhmm.test(r.start)||!hhmm.test(r.end)||r.start>=r.end))return null;
  const group=days.get(r.date)||[];group.push(r);days.set(r.date,group);
 }
 for(const group of days.values()){
  if(group.some(r=>r.type==='closed')&&group.length>1)return null;
  const s=group.filter(r=>r.type==='custom_hours').sort((a,b)=>a.start.localeCompare(b.start));for(let i=1;i<s.length;i++)if(s[i].start<s[i-1].end)return null;
 }
 return a;
}
async function change(pool,id,userId,type,b){
 let payload;
 if(type==='details')payload=checkProfile(b);
 if(type==='hours')payload=checkHours(b.hours_json);
 if(type==='exceptions')payload=checkExceptions(b.exceptions_json);
 if(type==='booking')payload= b.booking_enabled==='on';
 if(payload===null||payload===undefined)return {status:'invalid'};
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT set_config('sdc.user_id',$1,true)",[String(userId)]);
  const lock=await client.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active' FOR UPDATE`,[id]);
  if(!lock.rowCount){await client.query('ROLLBACK');return {status:'not_found'};}
  if(type==='details')await client.query(`UPDATE sdc."CLINIC" SET "Clinic_Name"=$2,"Clinic_Phone"=$3,"Clinic_Email"=$4,"City"=$5,"Area"=$6,"Address_Text"=$7,"Description"=$8,"Latitude"=$9::numeric,"Longitude"=$10::numeric WHERE "Clinic_ID"=$1::bigint`,[id,payload.name,payload.phone,payload.email,payload.city,payload.area,payload.address,payload.description||null,payload.lat,payload.lng]);
  if(type==='booking')await client.query(`UPDATE sdc."CLINIC" SET "Online_Booking_Enabled"=$2::boolean WHERE "Clinic_ID"=$1::bigint`,[id,payload]);
  if(type==='hours'){
   await client.query('DELETE FROM sdc."CLINIC_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint',[id]);
   for(const r of payload)await client.query('INSERT INTO sdc."CLINIC_WORKING_HOURS"("Day_Of_Week","Start_Time","End_Time","Clinic_ID") VALUES($1::smallint,$2::time,$3::time,$4::bigint)',[r.day,r.start,r.end,id]);
  }
  if(type==='exceptions'){
   await client.query('DELETE FROM sdc."CLINIC_WORKING_EXCEPTIONS" WHERE "Clinic_ID"=$1::bigint',[id]);
   for(const r of payload)await client.query(`INSERT INTO sdc."CLINIC_WORKING_EXCEPTIONS"("Exception_Date","Exception_Type","Start_Time","End_Time","Reason","Clinic_ID") VALUES($1::date,$2::varchar(150),$3::time,$4::time,$5::text,$6::bigint)`,[r.date,r.type,r.type==='closed'?null:r.start,r.type==='closed'?null:r.end,r.reason.trim(),id]);
  }
  // Reject schedule changes that would displace an existing pending/confirmed
  // appointment.  The PostgreSQL deferred integrity trigger remains the final
  // safeguard; this preflight produces a useful message in the original form.
  if(type==='hours'||type==='exceptions'){
   const conflict=await client.query(`SELECT b."Booking_ID" FROM sdc."BOOKING" b
    WHERE b."Clinic_ID"=$1::bigint AND b."Booking_Status" IN ('pending','confirmed')
    AND (
     EXISTS(SELECT 1 FROM sdc."CLINIC_WORKING_EXCEPTIONS" e WHERE e."Clinic_ID"=b."Clinic_ID" AND e."Exception_Date"=b."Appointment_Date" AND e."Exception_Type"='closed')
     OR (EXISTS(SELECT 1 FROM sdc."CLINIC_WORKING_EXCEPTIONS" e WHERE e."Clinic_ID"=b."Clinic_ID" AND e."Exception_Date"=b."Appointment_Date")
      AND NOT EXISTS(SELECT 1 FROM sdc."CLINIC_WORKING_EXCEPTIONS" e WHERE e."Clinic_ID"=b."Clinic_ID" AND e."Exception_Date"=b."Appointment_Date" AND e."Exception_Type"='custom_hours' AND b."Start_Time">=e."Start_Time" AND b."Start_Time"+make_interval(mins=>b."Duration_Minutes_Snapshot")<=e."End_Time"))
     OR (NOT EXISTS(SELECT 1 FROM sdc."CLINIC_WORKING_EXCEPTIONS" e WHERE e."Clinic_ID"=b."Clinic_ID" AND e."Exception_Date"=b."Appointment_Date")
      AND NOT EXISTS(SELECT 1 FROM sdc."CLINIC_WORKING_HOURS" h WHERE h."Clinic_ID"=b."Clinic_ID" AND h."Day_Of_Week"=extract(dow FROM b."Appointment_Date") AND b."Start_Time">=h."Start_Time" AND b."Start_Time"+make_interval(mins=>b."Duration_Minutes_Snapshot")<=h."End_Time"))
    ) LIMIT 1`,[id]);
   if(conflict.rowCount){await client.query('ROLLBACK');return {status:'bookings_conflict'};}
  }
  // The existing schema protects pending AI bookings when online booking is
  // disabled.  Explain the block here instead of surfacing a generic HTTP 503.
  if(type==='booking'&&!payload){
   const pending=await client.query(`SELECT "Booking_ID" FROM sdc."BOOKING" WHERE "Clinic_ID"=$1::bigint AND "Booking_Source"='ai' AND "Booking_Status" IN ('pending','confirmed') LIMIT 1`,[id]);
   if(pending.rowCount){await client.query('ROLLBACK');return {status:'ai_pending'};}
  }
  await client.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,$1::varchar(150),'Clinic',$2::varchar(512),$3::text,$4::bigint)`,[`clinic.settings.${type}`,String(id),'تحديث إعدادات العيادة',userId]);
  await client.query('COMMIT');return {status:'ok'};
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
}
async function readServices(pool,id){
 const [catalog,offers,doctors]=await Promise.all([
  pool.query('SELECT "Service_ID","Service_Name" FROM sdc."SERVICE" ORDER BY "Service_Name" LIMIT 500'),
  pool.query(`SELECT o.*,s."Service_Name",array_remove(array_agg(p."Doctor_ID") FILTER (WHERE p."Doctor_ID" IS NOT NULL),NULL) AS doctor_ids FROM sdc."OFFERS" o JOIN sdc."SERVICE" s ON s."Service_ID"=o."Service_ID" LEFT JOIN sdc."PROVIDES" p ON p."Clinic_ID"=o."Clinic_ID" AND p."Service_ID"=o."Service_ID" WHERE o."Clinic_ID"=$1::bigint GROUP BY o."Clinic_ID",o."Service_ID",s."Service_ID" ORDER BY s."Service_Name"`,[id]),
  pool.query(`SELECT w."Doctor_ID",u."First_Name",u."Last_Name" FROM sdc."WORKS_AT" w JOIN sdc."DOCTOR" d ON d."Doctor_ID"=w."Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID" WHERE w."Clinic_ID"=$1::bigint AND w."Membership_Status"='active' ORDER BY u."First_Name"`,[id])
 ]);
 return {catalog:catalog.rows,offers:offers.rows,doctors:doctors.rows};
}
function checkService(b){
 const id=String(b.service_id||'');const name=String(b.new_service_name||'').trim();
 const price=Number(b.price),duration=Number(b.duration);
 let doctorIds=b.doctor_ids; if(typeof doctorIds==='string')doctorIds=[doctorIds];if(!doctorIds)doctorIds=[];
 if(!Array.isArray(doctorIds)||doctorIds.length>50||new Set(doctorIds).size!==doctorIds.length||doctorIds.some(v=>!NUM.test(String(v)))||!(id==='__new__'||NUM.test(id))||id==='__new__'&&!text(name,150)||!text(b.price,24)||!Number.isFinite(price)||price<0||price>9999999999||!Number.isInteger(duration)||duration<1||duration>1440||!['true','false'].includes(b.installments)||!['true','false'].includes(b.available))return null;
 return {id,name,price,duration,installments:b.installments==='true',available:b.available==='true',doctorIds};
}
async function saveService(pool,id,userId,b){
 const v=checkService(b);if(!v)return {status:'invalid'};
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query("SELECT set_config('sdc.user_id',$1,true)",[String(userId)]);
  const active=await client.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active' FOR UPDATE`,[id]);
  if(!active.rowCount){await client.query('ROLLBACK');return {status:'forbidden'};}
  let serviceId=v.id;
  if(serviceId==='__new__'){
   const existing=await client.query(`SELECT "Service_ID" FROM sdc."SERVICE" WHERE lower("Service_Name")=lower($1::varchar(150)) LIMIT 1`,[v.name]);
   if(existing.rowCount){await client.query('ROLLBACK');return {status:'duplicate'};}
   const ins=await client.query('INSERT INTO sdc."SERVICE"("Service_Name") VALUES($1::varchar(150)) RETURNING "Service_ID"',[v.name]);serviceId=String(ins.rows[0].Service_ID);
  }
  const exists=await client.query('SELECT 1 FROM sdc."SERVICE" WHERE "Service_ID"=$1::bigint',[serviceId]);if(!exists.rowCount){await client.query('ROLLBACK');return {status:'invalid'};}
  if(v.doctorIds.length){const rs=await client.query(`SELECT "Doctor_ID"::text AS id FROM sdc."WORKS_AT" WHERE "Clinic_ID"=$1::bigint AND "Membership_Status"='active' AND "Doctor_ID"=ANY($2::bigint[])`,[id,v.doctorIds]);if(rs.rowCount!==v.doctorIds.length){await client.query('ROLLBACK');return {status:'doctors'};}}
  await client.query(`INSERT INTO sdc."OFFERS"("Price","Duration_Minutes","Allows_Installments","Is_Available","Clinic_ID","Service_ID") VALUES($1::numeric,$2::integer,$3::boolean,$4::boolean,$5::bigint,$6::bigint)
   ON CONFLICT("Clinic_ID","Service_ID") DO UPDATE SET "Price"=EXCLUDED."Price","Duration_Minutes"=EXCLUDED."Duration_Minutes","Allows_Installments"=EXCLUDED."Allows_Installments","Is_Available"=EXCLUDED."Is_Available"`,[v.price,v.duration,v.installments,v.available,id,serviceId]);
  // Update only changed doctor assignments: deleting and recreating existing links
  // would break existing appointment FKs even if the doctor stays assigned.
  const existingLinks=await client.query('SELECT "Doctor_ID"::text AS id FROM sdc."PROVIDES" WHERE "Clinic_ID"=$1::bigint AND "Service_ID"=$2::bigint',[id,serviceId]);
  const previous=new Set(existingLinks.rows.map(r=>String(r.id))),wanted=new Set(v.doctorIds);
  for(const oldId of previous)if(!wanted.has(oldId))await client.query('DELETE FROM sdc."PROVIDES" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Service_ID"=$3::bigint',[id,oldId,serviceId]);
  for(const doctorId of wanted)if(!previous.has(doctorId))await client.query('INSERT INTO sdc."PROVIDES"("Clinic_ID","Doctor_ID","Service_ID") VALUES($1::bigint,$2::bigint,$3::bigint)',[id,doctorId,serviceId]);
  await client.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,'clinic.service.saved','Clinic',$1::varchar(512),$2::text,$3::bigint)`,[id,`تحديث الخدمة ${serviceId}`,userId]);
  await client.query('COMMIT');return {status:'ok'};
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
}
module.exports={clinicId,readProfile,checkProfile,checkHours,checkExceptions,change,readServices,checkService,saveService};
