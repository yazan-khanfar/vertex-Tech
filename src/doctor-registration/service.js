'use strict';
const { hashPassword } = require('../security/password');
const { SPECIALTIES } = require('./specialties');

async function registerDoctor(pool, doctor, policyVersion) {
  if (!policyVersion || policyVersion.length > 150) throw new Error('POLICY_VERSION must be configured (max 150 chars).');
  const hash = await hashPassword(doctor.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'Asia/Hebron'");
    const role = await client.query('SELECT "Role_ID" FROM sdc."ROLE" WHERE "Role_Name"=$1 AND "Role_Scope"=$2', ['Doctor','System']);
    if (role.rowCount!==1) {const err=new Error('Doctor role is missing. Run npm run db:seed:doctor.');err.code='ROLE_MISSING';throw err;}
    // Never auto-verify or activate a doctor. A separate authenticated Super Admin
    // approval flow is required to change these statuses.
    const user = await client.query(`INSERT INTO sdc."USER"
      ("First_Name","Last_Name","Email","Phone","Password_Hash","Account_Status","Created_At","Preferred_Language","Two_Factor_Enabled","Login_Enabled","Role_ID")
      VALUES ($1,$2,$3,$4,$5,'pending',LOCALTIMESTAMP,'ar',false,false,$6) RETURNING "User_ID"`,
    [doctor.firstName,doctor.lastName,doctor.email,doctor.phone,hash,role.rows[0].Role_ID]);
    const userId=user.rows[0].User_ID;
    const created=await client.query(`INSERT INTO sdc."DOCTOR"
      ("License_Number","License_Status","User_ID") VALUES ($1,'pending',$2) RETURNING "Doctor_ID"`,[doctor.license,userId]);
    const doctorId=created.rows[0].Doctor_ID;
    for(const code of doctor.specialties) {
      // SPECIALTY has names but no code: map the validated form code via a fixed
      // server-side whitelist to an existing active catalog entry.
      const numeric=/^[1-9]\d{0,17}$/.test(code);
      const catalog=numeric
       ?await client.query('SELECT "Specialty_ID" FROM sdc."SPECIALTY" WHERE "Specialty_ID"=$1::bigint AND "Is_Active"=true',[code])
       :await client.query('SELECT "Specialty_ID" FROM sdc."SPECIALTY" WHERE "Name_EN"=$1 AND "Is_Active"=true', [SPECIALTIES[code]?.en||'']);
      if(catalog.rowCount!==1) {const err=new Error(`Doctor specialty not seeded or inactive: ${code}`);err.code='SPECIALTY_MISSING';throw err;}
      await client.query('INSERT INTO sdc."HAS_SPECIALTY" ("Doctor_ID","Specialty_ID") VALUES ($1,$2)',[doctorId,catalog.rows[0].Specialty_ID]);
    }
    // These preferences express the applicant's requested specialties only; the
    // license gate still prevents actual practice until manual verification.
    for (const type of ['terms_of_use','privacy_policy']) {
      await client.query(`INSERT INTO sdc."USER_POLICY_CONSENTS" ("Policy_Type","Policy_Version","Accepted_At","User_ID")
        VALUES ($1,$2,LOCALTIMESTAMP,$3)`,[type,policyVersion,userId]);
    }
    await client.query('COMMIT');
    return {userId,doctorId};
  } catch(err) {
    try {await client.query('ROLLBACK');} catch(rollbackError) {console.error('Doctor rollback failed:',rollbackError.message);}
    throw err;
  } finally {client.release();}
}
module.exports={registerDoctor};
