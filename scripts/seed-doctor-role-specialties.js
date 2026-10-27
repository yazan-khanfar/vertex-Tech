'use strict';
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'..','.env');
if(fs.existsSync(file))process.loadEnvFile(file);
const {getPool}=require('../db/pool');
const {SPECIALTIES}=require('../src/doctor-registration/specialties');
(async()=>{
 const pool=getPool();
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('INSERT INTO sdc."ROLE" ("Role_Name","Role_Scope") VALUES ($1,$2) ON CONFLICT ("Role_Name","Role_Scope") DO NOTHING',['Doctor','System']);
  for(const [code,{ar,en}] of Object.entries(SPECIALTIES)) {
    // No unique Name_EN constraint in supplied schema: refuse ambiguity rather than
    // attach a doctor to an unpredictable duplicate row.
    const existing=await client.query('SELECT "Specialty_ID","Is_Active" FROM sdc."SPECIALTY" WHERE "Name_EN"=$1',[en]);
    if(existing.rowCount>1)throw new Error(`Duplicate specialty for ${code}; resolve manually.`);
    if(existing.rowCount===1){
      if(!existing.rows[0].Is_Active)throw new Error(`Specialty ${code} is inactive; resolve manually.`);
      continue;
    }
    await client.query('INSERT INTO sdc."SPECIALTY" ("Name_AR","Name_EN","Is_Active") VALUES ($1,$2,true)',[ar,en]);
  }
  await client.query('COMMIT');
  console.log('Doctor role and six professional specialties ready. Existing data retained.');
 } catch(e) {await client.query('ROLLBACK');throw e;}
 finally {client.release();await pool.end();}
})().catch(e=>{console.error('Could not seed Doctor role/specialties:',e.message);process.exitCode=1;});
