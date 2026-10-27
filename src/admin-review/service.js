'use strict';
const { verifyPassword } = require('../security/password');

async function authenticateAdmin(pool, email, password) {
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 512) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) return null;
  const result = await pool.query(`SELECT u."User_ID", u."Password_Hash"
    FROM sdc."USER" u JOIN sdc."ROLE" r ON r."Role_ID"=u."Role_ID"
    WHERE lower(btrim(u."Email"))=$1 AND u."Account_Status"='active'
      AND u."Login_Enabled"=true AND r."Role_Name"='Super Admin' AND r."Role_Scope"='System'`, [normalized]);
  if (result.rowCount !== 1 || !result.rows[0].Password_Hash) return null;
  if (!await verifyPassword(password, result.rows[0].Password_Hash)) return null;
  return String(result.rows[0].User_ID);
}

async function adminIsActive(pool, userId) {
  if (!/^\d+$/.test(String(userId||''))) return false;
  const rows = await pool.query(`SELECT 1 FROM sdc."USER" u JOIN sdc."ROLE" r ON r."Role_ID"=u."Role_ID"
     WHERE u."User_ID"=$1 AND u."Account_Status"='active' AND u."Login_Enabled"=true
     AND r."Role_Name"='Super Admin' AND r."Role_Scope"='System'`, [userId]);
  return rows.rowCount === 1;
}

async function listDoctors(pool) {
  const result = await pool.query(`SELECT d."Doctor_ID", d."License_Number", d."License_Status",
       d."License_Review_Notes", u."First_Name",u."Last_Name",u."Email",u."Account_Status",u."Login_Enabled",
       COALESCE(string_agg(DISTINCT s."Name_AR", '، '), '') AS specialties
    FROM sdc."DOCTOR" d JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
    LEFT JOIN sdc."HAS_SPECIALTY" hs ON hs."Doctor_ID"=d."Doctor_ID"
    LEFT JOIN sdc."SPECIALTY" s ON s."Specialty_ID"=hs."Specialty_ID"
    GROUP BY d."Doctor_ID", d."License_Number",d."License_Status", d."License_Review_Notes",
      u."User_ID",u."First_Name",u."Last_Name",u."Email",u."Account_Status",u."Login_Enabled"
    ORDER BY CASE d."License_Status" WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, d."Doctor_ID" DESC`);
  return result.rows;
}

async function findDoctor(pool, doctorId) {
  const rows = await listDoctors(pool);
  return rows.find(row => String(row.Doctor_ID) === String(doctorId)) || null;
}

async function reviewDoctor(pool, {doctorId, adminUserId, decision, reason, checks}) {
  if (!/^[1-9]\d{0,17}$/.test(String(doctorId))) return {status:'invalid'};
  if (!/^[1-9]\d{0,17}$/.test(String(adminUserId))) return {status:'unauthorized'};
  if (decision !== 'approve' && decision !== 'reject') return {status:'invalid'};
  if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 1000) return {status:'invalid'};
  if (decision === 'approve' && !(['number_valid','identity_matches','specialty_matches'].every(k => checks?.[k] === 'on'))) return {status:'invalid_checks'};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'Asia/Hebron'");
    // Current request identity is asserted server-side, never from a user-submitted form.
    await client.query("SELECT set_config('sdc.user_id',$1,true)", [String(adminUserId)]);
    const actor = await client.query('SELECT sdc.sdc_is_superadmin($1::bigint) AS allowed', [String(adminUserId)]);
    if (actor.rows[0]?.allowed !== true) {await client.query('ROLLBACK');return {status:'unauthorized'};}
    const selected = await client.query(`SELECT d."Doctor_ID",d."License_Status",d."User_ID",u."Account_Status"
      FROM sdc."DOCTOR" d JOIN sdc."USER" u ON u."User_ID"=d."User_ID"
      WHERE d."Doctor_ID"=$1 FOR UPDATE OF d,u`,[doctorId]);
    if (selected.rowCount !== 1) {await client.query('ROLLBACK');return {status:'not_found'};}
    const doctor = selected.rows[0];
    if (doctor.License_Status !== 'pending' || doctor.Account_Status !== 'pending') {
      await client.query('ROLLBACK'); return {status:'already_reviewed'};
    }
    const approved = decision === 'approve';
    await client.query(`UPDATE sdc."DOCTOR" SET "License_Status"=$1,
       "License_Reviewed_By_User_ID"=$2,"License_Review_Notes"=$3 WHERE "Doctor_ID"=$4`,
       [approved?'verified':'rejected', adminUserId, reason.trim(), doctorId]);
    // Rejected is not a permitted account status in the supplied SQL schema; disabled is.
    await client.query(`UPDATE sdc."USER" SET "Account_Status"=$1,"Login_Enabled"=$2 WHERE "User_ID"=$3`,
      [approved?'active':'disabled',approved,doctor.User_ID]);
    await client.query(`INSERT INTO sdc."AUDIT_LOG" ("Occurred_At","Action_Type","Target_Type",
       "Target_Reference","Description","Reason","User_ID")
       VALUES (LOCALTIMESTAMP,$1,'Doctor',$2,$3,$4,$5)`,
      [approved?'doctor.license.approved':'doctor.license.rejected',String(doctorId),
       approved?'اعتماد رقم الترخيص الطبي':'رفض رقم الترخيص الطبي',reason.trim(),adminUserId]);
    await client.query('COMMIT');
    return {status:'ok',decision};
  } catch (error) {
    try {await client.query('ROLLBACK');} catch { /* logging below */ }
    throw error;
  } finally {client.release();}
}
module.exports = {authenticateAdmin,adminIsActive,listDoctors,findDoctor,reviewDoctor};
