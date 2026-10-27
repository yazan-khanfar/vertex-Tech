'use strict';
// Source timestamps and clinic working hours use the schema's Asia/Hebron zone.
process.env.TZ = 'Asia/Hebron';
const { Pool } = require('pg');
let pool;
function getPool() {
  if (!process.env.DATABASE_URL) {
    const error = new Error('DATABASE_URL is missing; configure .env before registering accounts.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=Asia/Hebron', max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  return pool;
}
module.exports = { getPool };
