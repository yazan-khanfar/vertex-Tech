'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const app = path.resolve(__dirname, '..');
process.loadEnvFile(path.join(app, '.env'));
const { getPool } = require(path.join(app, 'db/pool'));
const pool = getPool();
const email = `onboarding-${crypto.randomUUID()}@example.invalid`;
const password = crypto.randomBytes(24).toString('hex') + 'Aa1';
const cookies = new Map();
async function request(route, form) {
  const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + route, {
    method: form ? 'POST' : 'GET', redirect: 'manual',
    headers: { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '),
      ...(form ? {'Content-Type':'application/x-www-form-urlencoded'} : {}) },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [key, value] = cookie.split(';')[0].split('=');
    cookies.set(key,value);
  }
  return { status: response.status, location: response.headers.get('location'), text: await response.text() };
}
function token(html) {
  const result = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  assert(result, 'CSRF field must be rendered');
  return result[1];
}
(async () => {
  try {
    assert.equal((await request('/')).status,200);
    assert.equal((await request('/doctor/assets/styles.css')).status,200);
    assert.equal((await request('/patient/index')).location,'/auth/login');
    const registration = await request('/auth/register/patient');
    assert.equal(registration.status,200);
    const result = await request('/auth/register/patient', {
      csrf_token: token(registration.text), first_name:'Onboarding', last_name:'Smoke',
      date_of_birth:'1995-01-01', gender:'male', phone:'0590000000', email,
      password, confirm_password:password, accept_policies:'on'
    });
    assert.equal(result.status,303,'Real PostgreSQL registration must succeed');
    assert.equal(result.location,'/auth/register/success?role=patient');
    const saved = await pool.query('SELECT u."User_ID", (SELECT COUNT(*) FROM sdc."USER_POLICY_CONSENTS" c WHERE c."User_ID"=u."User_ID")::int consents FROM sdc."USER" u JOIN sdc."PATIENT" p USING ("User_ID") WHERE u."Email"=$1',[email]);
    assert.equal(saved.rowCount,1);
    assert.equal(saved.rows[0].consents,2);
    const login = await request('/auth/login');
    const signedIn = await request('/auth/login', {csrf_token:token(login.text),email,password});
    assert.equal(signedIn.status,303);
    assert.equal(signedIn.location,'/auth/continue');
    assert.equal((await request('/auth/continue')).location,'/patient/index');
    for (const route of ['/patient/index','/patient/profile','/patient/clinics','/patient/doctors']) {
      assert.equal((await request(route)).status,200,route+' must render after login');
    }
    const sessions = await pool.query('SELECT COUNT(*)::int n FROM sdc."USER_SESSIONS" WHERE "User_ID"=$1',[saved.rows[0].User_ID]);
    assert.equal(sessions.rows[0].n,1);
    console.log('PASS: HTTP pages/assets, access guard, PostgreSQL registration, two consents, login, persisted session, and four authenticated patient pages.');
  } finally {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT "User_ID" FROM sdc."USER" WHERE "Email"=$1',[email]);
      if (found.rowCount) {
        const id = found.rows[0].User_ID;
        for (const table of ['USER_SESSIONS','USER_POLICY_CONSENTS','PATIENT']) {
          await client.query(`DELETE FROM sdc."${table}" WHERE "User_ID"=$1`,[id]);
        }
        await client.query('DELETE FROM sdc."USER" WHERE "User_ID"=$1',[id]);
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); await pool.end(); }
  }
})().catch(error => { console.error(error.message); process.exitCode=1; });

