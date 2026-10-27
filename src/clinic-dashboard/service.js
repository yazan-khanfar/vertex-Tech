'use strict';
// Clinic dashboard (read-only). Every query is scoped to the manager's active clinic.
const {localNow}=require('../appointments/service');
const dayOfWeek=date=>new Date(date+'T12:00:00Z').getUTCDay();
const VALID_ID=/^[1-9]\d{0,17}$/;
const number=s=>Number(s||0);
const minute=s=>{const p=/^(\d\d):(\d\d)/.exec(String(s||''));return p?Number(p[1])*60+Number(p[2]):-1;};
const statusLabels={pending:'بانتظار الموافقة',confirmed:'مؤكد',in_progress:'داخل العلاج',completed:'مكتمل',no_show:'لم يحضر',cancelled:'ملغي',rejected:'مرفوض'};
const statusClasses={pending:'bg-warning-subtle text-warning',confirmed:'bg-primary-subtle text-primary',in_progress:'bg-info-subtle text-info',completed:'bg-success-subtle text-success',no_show:'bg-danger-subtle text-danger',cancelled:'bg-secondary-subtle text-secondary',rejected:'bg-danger-subtle text-danger'};
const initials=name=>String(name||'').trim().split(/\s+/u).filter(Boolean).slice(0,2).map(v=>Array.from(v)[0]).join('')||'—';
const fmtTime=time=>{const m=minute(time);if(m<0)return '';const h=Math.floor(m/60);return `${h%12||12}:${String(m%60).padStart(2,'0')} ${h<12?'ص':'م'}`;};
const intervalsOverlap=(a,b)=>minute(a.start)<minute(b.end)&&minute(b.start)<minute(a.end);
function effectiveHours(weekly,exceptions){
 if(exceptions.some(r=>r.type==='closed'))return [];
 return exceptions.length?exceptions.filter(e=>e.type==='custom_hours'):weekly;
}
function dashboardDateLabel(date){return new Intl.DateTimeFormat('ar-PS',{timeZone:'Asia/Hebron',weekday:'long',year:'numeric',month:'long',day:'numeric'}).format(new Date(date+'T12:00:00Z'));}
function hoursLabel(hours){return hours.length?hours.map(h=>`${fmtTime(h.start)} – ${h.end==='24:00'?'12:00 ص':fmtTime(h.end)}`).join('، '):'لا توجد ساعات عمل اليوم';}
function selectScheduledDoctors(rows,clinicHours){
 const seen=new Map();if(!clinicHours.length)return [];
 for(const r of rows){const p={start:r.start,end:r.end};if(!clinicHours.some(c=>intervalsOverlap(c,p)))continue;
  if(!seen.has(String(r.id)))seen.set(String(r.id),{id:String(r.id),name:r.name,specialties:r.specialties||'طب الأسنان',until:r.end});
  else if(minute(r.end)>minute(seen.get(String(r.id)).until))seen.get(String(r.id)).until=r.end;
 }
 return Array.from(seen.values()).slice(0,8).map(d=>({...d,initials:initials(d.name),untilLabel:d.until==='24:00'?'نهاية اليوم':fmtTime(d.until)}));
}
async function load(pool,clinicId,now=localNow()){
 if(!VALID_ID.test(String(clinicId||'')))return null;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(now.date)||!/^\d\d:\d\d$/.test(now.time))throw new Error('Invalid clinic-local clock');
 const id=String(clinicId),date=now.date,day=dayOfWeek(date);
 const clinicResult=await pool.query(`/* dashboard:clinic */
 SELECT "Clinic_ID"::text AS id,"Clinic_Name" AS name FROM sdc."CLINIC"
 WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active'`,[id]);
 const clinic=clinicResult.rows[0];if(!clinic)return null;
 // Database date and time are explicit Asia/Hebron wall-clock values; server TZ must not affect counts.
 const [weekly,exceptions,summary,todayBookings,pendingRequests,reschedules,doctorHours,invoiceSummary,unpaid]=await Promise.all([
  pool.query(`/* dashboard:weekly */ SELECT to_char("Start_Time",'HH24:MI') AS start,CASE WHEN "End_Time"=TIME '24:00' THEN '24:00' ELSE to_char("End_Time",'HH24:MI') END AS "end" FROM sdc."CLINIC_WORKING_HOURS" WHERE "Clinic_ID"=$1::bigint AND "Day_Of_Week"=$2::smallint ORDER BY "Start_Time"`,[id,day]),
  pool.query(`/* dashboard:exceptions */ SELECT "Exception_Type" AS type,to_char("Start_Time",'HH24:MI') AS start,CASE WHEN "End_Time"=TIME '24:00' THEN '24:00' ELSE to_char("End_Time",'HH24:MI') END AS "end" FROM sdc."CLINIC_WORKING_EXCEPTIONS" WHERE "Clinic_ID"=$1::bigint AND "Exception_Date"=$2::date`,[id,date]),
  pool.query(`/* dashboard:counts */ SELECT
    COUNT(*) FILTER (WHERE "Booking_Status" NOT IN ('cancelled','rejected'))::int AS total,
    COUNT(*) FILTER (WHERE "Booking_Status"='confirmed')::int AS confirmed,
    COUNT(*) FILTER (WHERE "Booking_Status"='pending')::int AS waiting,
    COUNT(*) FILTER (WHERE "Booking_Status"='completed')::int AS completed
    FROM sdc."BOOKING" WHERE "Clinic_ID"=$1::bigint AND "Appointment_Date"=$2::date`,[id,date]),
  pool.query(`/* dashboard:appointments */ SELECT b."Booking_ID"::text AS id,to_char(b."Start_Time",'HH24:MI') AS time,b."Booking_Status" AS status,
    u."First_Name"||' '||u."Last_Name" AS patient,s."Service_Name" AS service,
    du."First_Name"||' '||du."Last_Name" AS doctor
    FROM sdc."BOOKING" b JOIN sdc."PATIENT" p ON p."Patient_ID"=b."Patient_ID"
    JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
    JOIN sdc."DOCTOR" d ON d."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" du ON du."User_ID"=d."User_ID"
    JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID"
    WHERE b."Clinic_ID"=$1::bigint AND b."Appointment_Date"=$2::date AND b."Booking_Status" NOT IN ('cancelled','rejected')
    ORDER BY b."Start_Time",b."Booking_ID" LIMIT 10`,[id,date]),
  pool.query(`/* dashboard:pending */ SELECT b."Booking_ID"::text AS id,COUNT(*) OVER()::int AS total_pending,to_char(b."Appointment_Date",'YYYY-MM-DD') AS date,to_char(b."Start_Time",'HH24:MI') AS time,
    u."First_Name"||' '||u."Last_Name" AS patient, du."First_Name"||' '||du."Last_Name" AS doctor
    FROM sdc."BOOKING" b JOIN sdc."PATIENT" p ON p."Patient_ID"=b."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
    JOIN sdc."DOCTOR" d ON d."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" du ON du."User_ID"=d."User_ID"
    WHERE b."Clinic_ID"=$1::bigint AND b."Booking_Status"='pending'
    ORDER BY b."Created_At",b."Booking_ID" LIMIT 4`,[id]),
  pool.query(`/* dashboard:reschedules */ SELECT b."Booking_ID"::text AS id,to_char(b."Requested_Date",'YYYY-MM-DD') AS date,to_char(b."Requested_Start_Time",'HH24:MI') AS time,
    u."First_Name"||' '||u."Last_Name" AS patient
    FROM sdc."BOOKING" b JOIN sdc."PATIENT" p ON p."Patient_ID"=b."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID"
    WHERE b."Clinic_ID"=$1::bigint AND b."Request_Status"='pending' AND b."Booking_Status" IN ('pending','confirmed')
    ORDER BY b."Requested_At",b."Booking_ID" LIMIT 3`,[id]),
  pool.query(`/* dashboard:doctors */ SELECT w."Doctor_ID"::text AS id,u."First_Name"||' '||u."Last_Name" AS name,
    COALESCE((SELECT string_agg(DISTINCT s."Name_AR",'، ') FROM sdc."HAS_SPECIALTY" hs JOIN sdc."SPECIALTY" s ON s."Specialty_ID"=hs."Specialty_ID"
      WHERE hs."Doctor_ID"=w."Doctor_ID" AND s."Is_Active"=true),'طب الأسنان') AS specialties,
    to_char(h."Start_Time",'HH24:MI') AS start,CASE WHEN h."End_Time"=TIME '24:00' THEN '24:00' ELSE to_char(h."End_Time",'HH24:MI') END AS "end"
    FROM sdc."WORKS_AT" w JOIN sdc."DOCTOR" d ON d."Doctor_ID"=w."Doctor_ID" JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
    JOIN sdc."DOCTOR_WORKING_HOURS" h ON h."Clinic_ID"=w."Clinic_ID" AND h."Doctor_ID"=w."Doctor_ID" AND h."Is_Active"=true AND h."Day_Of_Week"=$2::smallint
    WHERE w."Clinic_ID"=$1::bigint AND w."Membership_Status"='active' AND w."Start_Date"<=$3::date
    AND d."License_Status"='verified' AND u."Account_Status"='active'
    AND NOT EXISTS (SELECT 1 FROM sdc."DOCTOR_ABSENCES" a WHERE a."Clinic_ID"=w."Clinic_ID" AND a."Doctor_ID"=w."Doctor_ID" AND $3::date BETWEEN a."From_Date" AND a."To_Date")
    ORDER BY name,h."Start_Time"`,[id,day,date]),
  pool.query(`/* dashboard:invoice-count */ SELECT COUNT(*)::int AS count FROM sdc.invoice_balances WHERE "Clinic_ID"=$1::bigint AND "Invoice_Status"='issued' AND remaining_amount>0`,[id]),
  pool.query(`/* dashboard:invoices */ SELECT "Invoice_ID"::text AS id,remaining_amount::text AS amount FROM sdc.invoice_balances
     WHERE "Clinic_ID"=$1::bigint AND "Invoice_Status"='issued' AND remaining_amount>0 ORDER BY "Created_At", "Invoice_ID" LIMIT 2`,[id])
 ]);
 const clinicHours=effectiveHours(weekly.rows,exceptions.rows);
 const currentMinute=minute(now.time);
 const open=clinicHours.some(h=>minute(h.start)<=currentMinute&&currentMinute<minute(h.end));
 const doctors=selectScheduledDoctors(doctorHours.rows,clinicHours);
 const alerts=[
  ...pendingRequests.rows.map(b=>({kind:'booking',id:b.id,title:'طلب حجز جديد',detail:`${b.patient} • ${b.doctor} • ${b.date} ${fmtTime(b.time)}`,url:`/clinic/appointment-details?id=${encodeURIComponent(b.id)}`})),
  ...reschedules.rows.map(b=>({kind:'reschedule',id:b.id,title:'طلب تغيير موعد',detail:`${b.patient} • ${b.date} ${fmtTime(b.time)}`,url:`/clinic/appointment-details?id=${encodeURIComponent(b.id)}`})),
  ...unpaid.rows.map(i=>({kind:'invoice',id:i.id,title:'فاتورة غير مكتملة',detail:`فاتورة ${i.id} • متبقي ${i.amount} ₪`,url:'/clinic/invoices'}))
 ].slice(0,7);
 const counts=summary.rows[0]||{};
 return {
  clinic, dateLabel:dashboardDateLabel(date),date,now:now.time,open,clinicHoursLabel:hoursLabel(clinicHours),
  stats:{today:number(counts.total),confirmed:number(counts.confirmed),waiting:number(counts.waiting),completed:number(counts.completed),
    pendingApprovals:Number(pendingRequests.rows[0]?.total_pending||0),doctorCount:doctors.length,unpaidInvoices:number(invoiceSummary.rows[0]?.count)},
  // Pending approvals card count must not be silently capped at the preview list limit.
  appointments:todayBookings.rows.map(b=>({...b,initials:initials(b.patient),timeLabel:fmtTime(b.time),statusLabel:statusLabels[b.status]||'غير معروف',statusClass:statusClasses[b.status]||'bg-secondary-subtle text-secondary'})),
  doctors,alerts
 };
}
module.exports={load,fmtTime,effectiveHours,selectScheduledDoctors,intervalsOverlap};
