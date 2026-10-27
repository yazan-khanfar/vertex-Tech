'use strict';
const { hashPassword } = require('../security/password');
async function registerPatient(pool, patient, policyVersion) {
  if (!policyVersion || policyVersion.length > 150) throw new Error('POLICY_VERSION must be configured (max 150 chars).');
  const hash = await hashPassword(patient.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'Asia/Hebron'");
    // The schema uses case-sensitive quoted names and a System-scoped Patient role.
    const role = await client.query('SELECT "Role_ID" FROM sdc."ROLE" WHERE "Role_Name"=$1 AND "Role_Scope"=$2', ['Patient','System']);
    if (role.rowCount !== 1) { const err = new Error('Patient role is not seeded. Run npm run db:seed:patient.'); err.code='ROLE_MISSING'; throw err; }
    const user = await client.query(`INSERT INTO sdc."USER"
      ("First_Name","Last_Name","Email","Phone","Password_Hash","Account_Status","Created_At","Preferred_Language","Two_Factor_Enabled","Login_Enabled","Role_ID")
      VALUES ($1,$2,$3,$4,$5,'active',LOCALTIMESTAMP,'ar',false,true,$6) RETURNING "User_ID"`,
    [patient.firstName,patient.lastName,patient.email,patient.phone,hash,role.rows[0].Role_ID]);
    const userId = user.rows[0].User_ID;
    await client.query(`INSERT INTO sdc."PATIENT" ("Date_Of_Birth","Gender","Blood_Type","Health_Notes","User_ID")
      VALUES ($1,$2,'unknown','لم تُستكمل البيانات الصحية بعد',$3)`, [patient.dob,patient.gender,userId]);
    // A recorded consent is versioned. Ensure actual policies are published before production use.
    for (const type of ['terms_of_use', 'privacy_policy']) {
      await client.query(`INSERT INTO sdc."USER_POLICY_CONSENTS" ("Policy_Type","Policy_Version","Accepted_At","User_ID")
        VALUES ($1,$2,LOCALTIMESTAMP,$3)`, [type,policyVersion,userId]);
    }
    await client.query('COMMIT');
    return { userId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Registration rollback failed:', rollbackError.message); }
    throw error;
  } finally { client.release(); }
}
module.exports = { registerPatient };
