'use strict';
/** Read only account details: the authenticated doctor owns this record.
 * No clinic membership is required and no clinical data is exposed.
 */
async function loadDoctorProfile(pool, userId, doctorId) {
  const result = await pool.query(`
    SELECT u."First_Name", u."Last_Name", u."Email", u."Phone",
           u."Preferred_Language", u."Two_Factor_Enabled",
           d."Doctor_ID", d."License_Number", d."License_Status",
           d."Years_Of_Experience", d."Bio"
    FROM sdc."USER" AS u
    JOIN sdc."DOCTOR" AS d ON d."User_ID" = u."User_ID"
    WHERE u."User_ID" = $1 AND d."Doctor_ID" = $2
  `, [userId, doctorId]);
  if (result.rowCount !== 1) return null;
  const specialties = await pool.query(`
    SELECT s."Name_AR", s."Name_EN"
    FROM sdc."HAS_SPECIALTY" AS hs
    JOIN sdc."SPECIALTY" AS s ON s."Specialty_ID" = hs."Specialty_ID"
    WHERE hs."Doctor_ID" = $1
    ORDER BY s."Name_AR", s."Specialty_ID"
  `, [doctorId]);
  return { ...result.rows[0], specialties: specialties.rows };
}
module.exports = { loadDoctorProfile };
