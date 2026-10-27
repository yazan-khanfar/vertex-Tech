'use strict';
const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const { getPool } = require('../db/pool');
(async () => {
 const pool = getPool();
 try {
  const result = await pool.query('INSERT INTO sdc."ROLE" ("Role_Name","Role_Scope") VALUES ($1,$2) ON CONFLICT ("Role_Name","Role_Scope") DO NOTHING RETURNING "Role_ID"', ['Patient','System']);
  const row = await pool.query('SELECT "Role_ID" FROM sdc."ROLE" WHERE "Role_Name"=$1 AND "Role_Scope"=$2',['Patient','System']);
  console.log(`Patient role ready: ID ${row.rows[0].Role_ID} (${result.rowCount?'inserted':'already present'})`);
 } finally { await pool.end(); }
})().catch(e=>{console.error('Could not seed Patient role:',e.message);process.exitCode=1;});
