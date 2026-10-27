'use strict';
// Server authoritative bookings. All times are clinic-local Asia/Hebron.
const VALID_ID=/^[1-9]\d{0,17}$/;
const VALID_DATE=/^\d{4}-\d\d-\d\d$/;
const VALID_TIME=/^(?:[01]\d|2[0-3]):(?:00|30)$/;
const ACTIVE=['pending','confirmed','in_progress','completed'];
const labels={pending:'بانتظار الموافقة',confirmed:'مؤكد',in_progress:'جاري',completed:'مكتمل',cancelled:'ملغي',rejected:'مرفوض',no_show:'لم يحضر'};
const num=x=>VALID_ID.test(String(x||''))?String(x):null;
const hm=t=>{const m=/^(\d{2}):(\d{2})/.exec(String(t||''));return m?Number(m[1])*60+Number(m[2]):-1;};
const dateValid=d=>VALID_DATE.test(String(d))&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const dayOfWeek=d=>new Date(d+'T12:00:00Z').getUTCDay();
function localNow(){const x=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hebron',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const get=k=>x.find(p=>p.type===k).value;return {date:`${get('year')}-${get('month')}-${get('day')}`,time:`${get('hour')}:${get('minute')}`};}
function future(date,time){const now=localNow();return date>now.date || date===now.date&&time>now.time;}
async function catalog(db,clinicId){
 const rs=await db.query(`SELECT c."Clinic_ID"::text AS clinic_id,c."Clinic_Name" AS clinic_name,p."Doctor_ID"::text AS doctor_id,
 u."First_Name"||' '||u."Last_Name" AS doctor_name,o."Service_ID"::text AS service_id,s."Service_Name" AS service_name,
 o."Price"::text AS price,o."Duration_Minutes" AS duration
 FROM sdc."PROVIDES" p JOIN sdc."OFFERS" o ON o."Clinic_ID"=p."Clinic_ID" AND o."Service_ID"=p."Service_ID"
 JOIN sdc."WORKS_AT" w ON w."Clinic_ID"=p."Clinic_ID" AND w."Doctor_ID"=p."Doctor_ID"
 JOIN sdc."DOCTOR" d ON d."Doctor_ID"=p."Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
 JOIN sdc."SERVICE" s ON s."Service_ID"=p."Service_ID" JOIN sdc."CLINIC" c ON c."Clinic_ID"=p."Clinic_ID"
 WHERE c."Approval_Status"='approved' AND c."Clinic_Status"='active' AND o."Is_Available"=true
 AND w."Membership_Status"='active' AND d."License_Status"='verified' AND u."Account_Status"='active'
 AND ($1::bigint IS NOT NULL OR c."Online_Booking_Enabled"=true)
 AND ($1::bigint IS NULL OR c."Clinic_ID"=$1::bigint) ORDER BY c."Clinic_Name",doctor_name,s."Service_Name" LIMIT 2000`,[clinicId||null]);
 return rs.rows;
}
function chosen(rows,b){return rows.find(r=>r.clinic_id===String(b.clinic_id||'')&&r.doctor_id===String(b.doctor_id||'')&&r.service_id===String(b.service_id||''))||null;}
async function patientId(db,userId){const r=await db.query('SELECT "Patient_ID"::text AS id FROM sdc."PATIENT" WHERE "User_ID"=$1::bigint',[userId]);return r.rows[0]?.id||null;}
async function patientOptions(db,clinicId){const r=await db.query(`SELECT p."Patient_ID"::text AS id,u."First_Name"||' '||u."Last_Name" AS name FROM sdc."REGISTERED_AT" r JOIN sdc."PATIENT" p ON p."Patient_ID"=r."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE r."Clinic_ID"=$1::bigint ORDER BY name LIMIT 1000`,[clinicId]);return r.rows;}
// Availability is always the intersection of active doctor hours and clinic hours.
// Closed exceptions take precedence; custom-hours exceptions replace clinic weekly hours ONLY on their date.
// Return a reason so existing booking pages can explain why a normal working day has no slots.
async function availability(db,choice,date,patient=null,ignoreBooking=null){
 const empty=reason=>({slots:[],reason});
 if(!choice||!dateValid(date))return empty('invalid_date');
 if(date<localNow().date||date>new Date(Date.now()+180*86400000).toISOString().slice(0,10))return empty('out_of_range');
 const membership=await db.query(`SELECT 1 FROM sdc."WORKS_AT" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Membership_Status"='active' AND "Start_Date"<=$3::date`,[choice.clinic_id,choice.doctor_id,date]);
 if(!membership.rowCount)return empty('inactive_membership');
 const p=[choice.clinic_id,choice.doctor_id,date];
 const [weekly,exceptions,absence,busy]= [
 await db.query(`SELECT to_char("Start_Time",'HH24:MI') AS start,CASE WHEN "End_Time"=TIME '24:00' THEN '24:00' ELSE to_char("End_Time",'HH24:MI') END AS end FROM sdc."DOCTOR_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND "Day_Of_Week"=$3::smallint AND "Is_Active"=true`,[choice.clinic_id,choice.doctor_id,dayOfWeek(date)]),
 await db.query(`SELECT "Exception_Type" AS type,to_char("Start_Time",'HH24:MI') AS start,to_char("End_Time",'HH24:MI') AS end FROM sdc."CLINIC_WORKING_EXCEPTIONS" WHERE "Clinic_ID"=$1::bigint AND "Exception_Date"=$2::date`,[choice.clinic_id,date]),
 await db.query(`SELECT 1 FROM sdc."DOCTOR_ABSENCES" WHERE "Clinic_ID"=$1::bigint AND "Doctor_ID"=$2::bigint AND $3::date BETWEEN "From_Date" AND "To_Date" LIMIT 1`,p),
 await db.query(`SELECT to_char("Start_Time",'HH24:MI') AS start,"Duration_Minutes_Snapshot" AS duration FROM sdc."BOOKING" WHERE "Appointment_Date"=$1::date AND "Booking_Status" NOT IN ('cancelled','rejected','no_show') AND ("Doctor_ID"=$2::bigint OR ($3::bigint IS NOT NULL AND "Patient_ID"=$3::bigint)) AND ($4::bigint IS NULL OR "Booking_ID"<>$4::bigint)`,[date,choice.doctor_id,patient,ignoreBooking])
 ];
 // Never allow a closed day to become available, even if working hours exist.
 if(exceptions.rows.some(x=>x.type==='closed'))return empty('clinic_closed');
 if(absence.rowCount)return empty('doctor_absent');
 if(!weekly.rows.length)return empty('doctor_no_hours');
 const clinicHours=exceptions.rowCount
  ?exceptions.rows.filter(x=>x.type==='custom_hours')
  :(await db.query(`SELECT to_char("Start_Time",'HH24:MI') AS start,CASE WHEN "End_Time"=TIME '24:00' THEN '24:00' ELSE to_char("End_Time",'HH24:MI') END AS end FROM sdc."CLINIC_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Day_Of_Week"=$2::smallint`,[choice.clinic_id,dayOfWeek(date)])).rows;
 if(!clinicHours.length)return empty('clinic_no_hours');
 const duration=Number(choice.duration),out=[];
 let hasOverlap=false;
 for(const doc of weekly.rows)for(const c of clinicHours){
  const start=Math.ceil(Math.max(hm(doc.start),hm(c.start))/30)*30,end=Math.min(hm(doc.end),hm(c.end));
  if(start+duration<=end)hasOverlap=true;
  for(let time=start;time+duration<=end;time+=30){const t=`${String(Math.floor(time/60)).padStart(2,'0')}:${String(time%60).padStart(2,'0')}`;
   if(!future(date,t)||busy.rows.some(x=>time<hm(x.start)+Number(x.duration)&&time+duration>hm(x.start)))continue;
   out.push(t);
  }
 }
 if(!hasOverlap)return empty('no_overlap');
 if(!out.length)return empty('no_free_slots');
 return {slots:[...new Set(out)].sort(),reason:'available'};
}
async function slots(db,choice,date,patient=null,ignoreBooking=null){
 return (await availability(db,choice,date,patient,ignoreBooking)).slots;
}
const availabilityReasons=Object.freeze({
 invalid_date:'يرجى اختيار تاريخ صحيح.',
 out_of_range:'التاريخ خارج فترة الحجز المسموحة (حتى 180 يومًا من اليوم).',
 inactive_membership:'الطبيب غير مرتبط بهذه العيادة ارتباطًا نشطًا في التاريخ المختار.',
 clinic_closed:'العيادة مغلقة في هذا التاريخ بسبب استثناء إغلاق؛ لا يمكن الحجز فيه.',
 doctor_absent:'الطبيب في إجازة أو غياب خلال التاريخ المختار.',
 doctor_no_hours:'لا يوجد دوام فعّال للطبيب في هذا اليوم. راجع جدول دوام الطبيب داخل العيادة.',
 clinic_no_hours:'لا توجد ساعات عمل للعيادة في هذا اليوم. راجع الدوام الأسبوعي أو ساعات الاستثناء.',
 no_overlap:'ساعات عمل الطبيب والعيادة لا تتقاطع بما يكفي لمدة الخدمة.',
 no_free_slots:'ساعات الدوام موجودة، لكن كل الأوقات انتهت أو محجوزة لهذا اليوم.'
});
async function audit(db,action,id,userId,description){await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,$1::varchar(150),'Booking',$2::varchar(512),$3::text,$4::bigint)`,[action,String(id),description,userId]);}
async function note(db,userId,title,body,bookingId){await db.query(`INSERT INTO sdc."NOTIFICATION"("Title","Body","Notification_Type","Created_At","User_ID","Target_Type","Target_Reference") VALUES($1::varchar(150),$2::text,'booking',LOCALTIMESTAMP,$3::bigint,'Booking',$4::varchar(512))`,[title,body,userId,String(bookingId)]);}
async function transaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
async function book(pool,b,actor,clinicId){
 const date=String(b.appointment_date||b.clinic_booking_date||''),time=String(b.appointment_time||'');
 if(!dateValid(date)||!VALID_TIME.test(time)||!future(date,time)||!num(b.doctor_id)||!num(b.service_id)||!num(b.clinic_id)||String(b.notes||'').trim().length>2000)return {status:'invalid'};
 return transaction(pool,async db=>{
  await db.query("SELECT set_config('sdc.user_id',$1,true)",[actor.userId]);
  // Lock the doctor BEFORE reading slots; concurrent bookings by this doctor serialize.
  await db.query('SELECT "Doctor_ID" FROM sdc."DOCTOR" WHERE "Doctor_ID"=$1::bigint FOR UPDATE',[b.doctor_id]);
  let patient;
  if(actor.role==='patient')patient=await patientId(db,actor.userId);
  else if(actor.role==='doctor'&&clinicId===String(b.clinic_id))patient=num(b.patient_id);
  if(!patient)return {status:'forbidden'};
  await db.query('SELECT "Patient_ID" FROM sdc."PATIENT" WHERE "Patient_ID"=$1::bigint FOR UPDATE',[patient]);
  if(actor.role!=='patient'){const enrolled=await db.query('SELECT 1 FROM sdc."REGISTERED_AT" WHERE "Clinic_ID"=$1::bigint AND "Patient_ID"=$2::bigint',[clinicId,patient]);if(!enrolled.rowCount)return {status:'forbidden'};}
  const options=await catalog(db,clinicId||null),choice=chosen(options,b);
  if(!choice)return {status:'unavailable'};
  const validSlots=await slots(db,choice,date,patient);
  if(!validSlots.includes(time))return {status:'unavailable'};
  if(actor.role==='patient')await db.query('INSERT INTO sdc."REGISTERED_AT"("Patient_ID","Clinic_ID") VALUES($1::bigint,$2::bigint) ON CONFLICT DO NOTHING',[patient,choice.clinic_id]);
  // Optional follow-up linkage. It is not enough to pass a patient identifier:
  // lock the physician's completed visit and verify clinic/patient ownership.
  const followUpId=String(b.follow_up_visit_id||'').trim();
  if(followUpId&&!num(followUpId))return {status:'invalid'};
  if(followUpId){
   const q=await db.query(`SELECT v."Visit_ID" FROM sdc."VISIT" v JOIN sdc."BOOKING" previous ON previous."Booking_ID"=v."Booking_ID"
    WHERE v."Visit_ID"=$1::bigint AND previous."Clinic_ID"=$2::bigint AND previous."Patient_ID"=$3::bigint
    AND previous."Booking_Status"='completed' AND v."Follow_Up_Type" IS NOT NULL AND v."Suggested_Date" IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM sdc."BOOKING" later WHERE later."Follow_Up_Of_Visit_ID"=v."Visit_ID")
    FOR UPDATE OF v`,[followUpId,choice.clinic_id,patient]);
   if(!q.rowCount)return {status:'unavailable'};
  }
  const result=await db.query(`INSERT INTO sdc."BOOKING"("Appointment_Date","Start_Time","Duration_Minutes_Snapshot","Service_Price_Snapshot","Booking_Status","Booking_Source","Created_At","Patient_Notes","Patient_ID","Clinic_ID","Doctor_ID","Service_ID","Created_By_User_ID","Follow_Up_Of_Visit_ID")
   VALUES($1::date,$2::time,$3::integer,$4::numeric,$5::varchar(150),'manual',LOCALTIMESTAMP,$6::text,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,$12::bigint) RETURNING "Booking_ID"::text AS id`,
   [date,time,choice.duration,choice.price,actor.role==='patient'?'pending':'confirmed',String(b.notes||'').trim()||null,patient,choice.clinic_id,choice.doctor_id,choice.service_id,actor.userId,followUpId||null]);
  const id=result.rows[0].id;
  await audit(db,'booking.created',id,actor.userId,'إنشاء حجز فعلي مع الاحتفاظ بسعر الخدمة ومدة الجلسة');
  const receiver=await db.query(`SELECT u."User_ID"::text AS id FROM sdc."DOCTOR" d JOIN sdc."USER" u USING("User_ID") WHERE d."Doctor_ID"=$1::bigint`,[choice.doctor_id]);
  if(receiver.rowCount&&receiver.rows[0].id!==String(actor.userId))await note(db,receiver.rows[0].id,'موعد جديد','تم إنشاء موعد في عيادتك.',id);
  return {status:'ok',id};
 });
}
const LIST_SQL=`SELECT b."Booking_ID"::text AS id,to_char(b."Appointment_Date",'YYYY-MM-DD') AS date,to_char(b."Start_Time",'HH24:MI') AS time,b."Booking_Status" AS status,b."Arrived_At" IS NOT NULL AS arrived,b."Booking_Source" AS source,b."Duration_Minutes_Snapshot" AS duration,b."Service_Price_Snapshot"::text AS price,b."Patient_Notes" AS notes,b."Administrative_Notes" AS administrative_notes,b."Request_Status" AS request_status,to_char(b."Requested_Date",'YYYY-MM-DD') AS requested_date,to_char(b."Requested_Start_Time",'HH24:MI') AS requested_time,b."Change_Request_Reason" AS request_reason,b."Request_Source" AS request_source,b."Clinic_ID"::text AS clinic_id,b."Doctor_ID"::text AS doctor_id,b."Patient_ID"::text AS patient_id,c."Clinic_Name" AS clinic_name,s."Service_Name" AS service_name,pu."First_Name"||' '||pu."Last_Name" AS patient_name,du."First_Name"||' '||du."Last_Name" AS doctor_name
 FROM sdc."BOOKING" b JOIN sdc."CLINIC" c USING("Clinic_ID") JOIN sdc."SERVICE" s USING("Service_ID") JOIN sdc."PATIENT" p USING("Patient_ID") JOIN sdc."USER" pu ON pu."User_ID"=p."User_ID" JOIN sdc."DOCTOR" d USING("Doctor_ID") JOIN sdc."USER" du ON du."User_ID"=d."User_ID"`;
async function list(pool,actor,clinicId){let where,params;
 if(actor.role==='patient'){where='WHERE p."User_ID"=$1::bigint';params=[actor.userId];}
 else if(actor.role==='doctor'){where='WHERE b."Clinic_ID"=$1::bigint AND b."Doctor_ID"=$2::bigint';params=[clinicId,actor.doctorId];}
 else throw new Error('Unsupported actor');
 const rs=await pool.query(`${LIST_SQL} ${where} ORDER BY b."Appointment_Date" DESC,b."Start_Time" DESC LIMIT 300`,params);
 return rs.rows;
}
async function clinicList(pool,clinicId){const r=await pool.query(`${LIST_SQL} WHERE b."Clinic_ID"=$1::bigint ORDER BY b."Appointment_Date" DESC,b."Start_Time" DESC LIMIT 500`,[clinicId]);return r.rows;}
async function detail(pool,id,actor,clinicId){if(!num(id))return null;const r=await pool.query(`${LIST_SQL} WHERE b."Booking_ID"=$1::bigint`,[id]);const booking=r.rows[0];if(!booking)return null;
 if(actor.role==='patient'){const p=await patientId(pool,actor.userId);if(p!==booking.patient_id)return null;}
 else if(actor.role==='doctor'){if(!clinicId||clinicId!==booking.clinic_id||actor.doctorId!==booking.doctor_id&&!actor.isManager)return null;}else return null;
 return booking;
}
async function action(pool,actor,clinicId,b){const id=num(b.booking_id),name=String(b.action||'');if(!id||!['confirm','reject','cancel','move','request_change','approve_change','reject_change'].includes(name))return {status:'invalid'};
 const date=String(b.requested_date||''),time=String(b.requested_time||''),reason=String(b.reason||'').trim();
 if(['request_change','move'].includes(name)&&(!dateValid(date)||!VALID_TIME.test(time)||!future(date,time)||reason.length>2000||(name==='request_change'&&!reason)))return {status:'invalid'};
 // A clinic rejection must record an explanation that the patient can see.
 if(name==='reject'&&(!reason||reason.length>2000))return {status:'reason_required'};
 return transaction(pool,async db=>{
  await db.query("SELECT set_config('sdc.user_id',$1,true)",[actor.userId]);
  // Lock doctor before booking to match lock order used by new bookings.
  const doctor=await db.query('SELECT "Doctor_ID" FROM sdc."BOOKING" WHERE "Booking_ID"=$1::bigint',[id]);if(!doctor.rowCount)return {status:'not_found'};
  await db.query('SELECT 1 FROM sdc."DOCTOR" WHERE "Doctor_ID"=$1::bigint FOR UPDATE',[doctor.rows[0].Doctor_ID]);
  const booking=(await db.query(`${LIST_SQL} WHERE b."Booking_ID"=$1::bigint FOR UPDATE OF b`,[id])).rows[0];if(!booking)return {status:'not_found'};
  const manager=actor.role==='doctor'&&clinicId===booking.clinic_id&&actor.isManager;
  const physician=actor.role==='doctor'&&clinicId===booking.clinic_id&&actor.doctorId===booking.doctor_id;
  const patient=actor.role==='patient'&&(await patientId(db,actor.userId))===booking.patient_id;
  if(!(manager||physician||patient))return {status:'forbidden'};
  // Once the patient checks in, the session is handled by daily operations.
  if(booking.arrived&&['cancel','move','request_change','approve_change'].includes(name))return {status:'closed'};
  if(['confirm','reject','approve_change','reject_change','move'].includes(name)&&!manager)return {status:'forbidden'};
  if(!future(booking.date,booking.time)&&name!=='reject_change')return {status:'closed'};
  if(name==='confirm'||name==='reject'){
   if(booking.status!=='pending'||booking.request_status==='pending')return {status:'closed'};
   if(name==='reject'){
    // Reuse the existing administrative note on this rejected booking (no schema change).
    await db.query(`UPDATE sdc."BOOKING" SET "Booking_Status"='rejected',"Administrative_Notes"=$2::text WHERE "Booking_ID"=$1::bigint`,[id,reason]);
   }else{
    await db.query(`UPDATE sdc."BOOKING" SET "Booking_Status"='confirmed' WHERE "Booking_ID"=$1::bigint`,[id]);
   }
  }else if(name==='cancel'){
   if(!['pending','confirmed'].includes(booking.status)||booking.request_status==='pending')return {status:'closed'};
   await db.query('UPDATE sdc."BOOKING" SET "Booking_Status"=\'cancelled\' WHERE "Booking_ID"=$1::bigint',[id]);
  }else if(name==='move'){
   if(!['pending','confirmed'].includes(booking.status)||booking.request_status==='pending')return {status:'closed'};
   const service=(await db.query('SELECT "Service_ID"::text AS id FROM sdc."BOOKING" WHERE "Booking_ID"=$1::bigint',[id])).rows[0].id;
   const choice=(await catalog(db,booking.clinic_id)).find(x=>x.doctor_id===booking.doctor_id&&x.service_id===service);
   if(!choice||!(await slots(db,choice,date,booking.patient_id,id)).includes(time))return {status:'unavailable'};
   await db.query(`UPDATE sdc."BOOKING" SET "Appointment_Date"=$2::date,"Start_Time"=$3::time,"Administrative_Notes"=NULLIF($4::text,'') WHERE "Booking_ID"=$1::bigint`,[id,date,time,reason]);
  }else if(name==='request_change'){
   if(!['pending','confirmed'].includes(booking.status)||booking.request_status==='pending'||manager&&!physician)return {status:'closed'};
   const service=(await db.query('SELECT "Service_ID"::text AS id FROM sdc."BOOKING" WHERE "Booking_ID"=$1::bigint',[id])).rows[0].id;
   const choice=(await catalog(db,booking.clinic_id)).find(x=>x.doctor_id===booking.doctor_id&&x.service_id===service);
   if(!choice||!(await slots(db,choice,date,booking.patient_id,id)).includes(time))return {status:'unavailable'};
   await db.query(`UPDATE sdc."BOOKING" SET "Requested_Date"=$2::date,"Requested_Start_Time"=$3::time,"Change_Request_Reason"=$4::text,"Request_Source"=$5::varchar(150),"Requested_At"=LOCALTIMESTAMP,"Request_Status"='pending',"Resolved_At"=NULL WHERE "Booking_ID"=$1::bigint`,[id,date,time,reason,patient?'patient':'doctor']);
  }else{
   if(booking.request_status!=='pending')return {status:'closed'};
   if(name==='approve_change'){
    const service=(await db.query('SELECT "Service_ID"::text AS id FROM sdc."BOOKING" WHERE "Booking_ID"=$1::bigint',[id])).rows[0].id;
    const choice=(await catalog(db,booking.clinic_id)).find(x=>x.doctor_id===booking.doctor_id&&x.service_id===service);
    if(!choice||!(await slots(db,choice,booking.requested_date,booking.patient_id,id)).includes(booking.requested_time))return {status:'unavailable'};
    await db.query(`UPDATE sdc."BOOKING" SET "Appointment_Date"="Requested_Date","Start_Time"="Requested_Start_Time","Request_Status"='approved',"Resolved_At"=LOCALTIMESTAMP WHERE "Booking_ID"=$1::bigint`,[id]);
   }else await db.query(`UPDATE sdc."BOOKING" SET "Request_Status"='rejected',"Resolved_At"=LOCALTIMESTAMP WHERE "Booking_ID"=$1::bigint`,[id]);
  }
  await audit(db,`booking.${name}`,id,actor.userId,reason||`تغيير حالة الحجز: ${name}`);
  const user=(await db.query('SELECT "User_ID"::text AS id FROM sdc."PATIENT" WHERE "Patient_ID"=$1::bigint',[booking.patient_id])).rows[0];
  if(user&&user.id!==String(actor.userId))await note(db,user.id,name==='reject'?'رفض موعد':'تحديث موعد',name==='reject'?`تم رفض موعدك. السبب: ${reason}`:'تم تحديث حالة موعدك، افتح مواعيدي للمراجعة.',id);
  return {status:'ok',id};
 });
}
module.exports={catalog,chosen,patientId,patientOptions,availability,availabilityReasons,slots,book,list,clinicList,detail,action,num,dateValid,future,hm,localNow,labels,VALID_TIME};
