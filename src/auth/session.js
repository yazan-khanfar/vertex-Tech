'use strict';
const crypto=require('node:crypto');
// Intentionally development-only. No production session store is configured yet.
const sessions=new Map();
const COOKIE='sdc_session';
const MAX_AGE_MS=8*60*60*1000;
const MAX_SESSIONS=1000;
const pendingMfa=new Map();
const MFA_COOKIE='sdc_mfa_pending';
const MFA_TTL_MS=5*60*1000;
function parseCookie(req,name=COOKIE){
  return String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
}
function sessionKey(token){return crypto.createHash('sha256').update(token).digest('hex');}
function setCookie(res,token,ageSec){
  res.append('Set-Cookie',`${COOKIE}=${token}; Path=/; Max-Age=${ageSec}; HttpOnly; SameSite=Lax${process.env.NODE_ENV==='production'?'; Secure':''}`);
}
function createSession(res,{userId,role,mfaVerified=false}){
  if(process.env.NODE_ENV==='production') throw Error('Production session store and MFA required before launch');
  const now=Date.now();
  for(const [k,v] of sessions) if(v.expires<=now)sessions.delete(k);
  if(sessions.size>=MAX_SESSIONS)throw Error('Login capacity reached');
  const token=crypto.randomBytes(32).toString('hex');
  const session={userId:String(userId),role,mfaVerified,clinicId:null,csrf:crypto.createHash('sha256').update('sdc-csrf:'+token).digest('hex'),tokenHash:sessionKey(token),expires:now+MAX_AGE_MS};
  sessions.set(sessionKey(token),session);setCookie(res,token,Math.floor(MAX_AGE_MS/1000));return session;
}
function getSession(req){
  if(process.env.NODE_ENV==='production')return null;
  const token=parseCookie(req);
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const key=sessionKey(token),s=sessions.get(key);
  if(!s)return null;
  if(s.expires<=Date.now()){sessions.delete(key);return null;}
  return s;
}
function dropSession(req,res){const token=parseCookie(req);if(/^[a-f0-9]{64}$/.test(token))sessions.delete(sessionKey(token));setCookie(res,'',0);}
function sessionCsrf(req){return getSession(req)?.csrf||'';}
function validateSessionCsrf(req){
  const secret=sessionCsrf(req),submitted=req.body?.csrf_token;
  if(!secret||typeof submitted!=='string')return false;
  const a=Buffer.from(secret),b=Buffer.from(submitted);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function startMfaChallenge(res,{userId,role}){
 if(process.env.NODE_ENV==='production')throw Error('A production-capable challenge store is required');
 for(const [key,v] of pendingMfa)if(v.expires<=Date.now())pendingMfa.delete(key);
 if(pendingMfa.size>=500)throw Error('MFA challenge capacity reached');
 const raw=crypto.randomBytes(32).toString('hex');
 pendingMfa.set(sessionKey(raw),{userId:String(userId),role,expires:Date.now()+MFA_TTL_MS,attempts:0});
 res.append('Set-Cookie',`${MFA_COOKIE}=${raw}; Path=/auth; Max-Age=300; HttpOnly; SameSite=Strict`);
}
function getMfaChallenge(req){const token=parseCookie(req,MFA_COOKIE);if(!/^[a-f0-9]{64}$/.test(token))return null;const item=pendingMfa.get(sessionKey(token));if(!item)return null;if(item.expires<=Date.now()||item.attempts>=5){pendingMfa.delete(sessionKey(token));return null;}return item;}
function failMfaChallenge(req){const challenge=getMfaChallenge(req);if(!challenge)return null;challenge.attempts++;return challenge.attempts<5?challenge:null;}
function finishMfaChallenge(req,res){const raw=parseCookie(req,MFA_COOKIE);if(/^[a-f0-9]{64}$/.test(raw))pendingMfa.delete(sessionKey(raw));res.append('Set-Cookie',`${MFA_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Strict`);}
function revokeOtherSessions(userId,keepSession){for(const [key,s] of sessions)if(s.userId===String(userId)&&s!==keepSession)sessions.delete(key);}
function revokeUserSessions(userId){
  for(const [key,s] of sessions)if(s.userId===String(userId))sessions.delete(key);
  for(const [key,s] of pendingMfa)if(s.userId===String(userId))pendingMfa.delete(key);
}

// Persist the hash of a random cookie token only. Never persist the cookie/token itself.
function parseSessionToken(req){const raw=parseCookie(req);return /^[a-f0-9]{64}$/.test(raw)?raw:'';}
function browserFromAgent(agent){
 const a=String(agent||'');
 return /Edg\//.test(a)?'Microsoft Edge':/Firefox\//.test(a)?'Firefox':/Chrome\//.test(a)?'Chrome':/Safari\//.test(a)?'Safari':'متصفح غير معروف';
}
function deviceFromAgent(agent){
 const a=String(agent||'');
 return /Windows/.test(a)?'Windows':/Android/.test(a)?'Android':/iPhone|iPad/.test(a)?'iPhone / iPad':/Macintosh/.test(a)?'macOS':/Linux/.test(a)?'Linux':'جهاز غير معروف';
}
async function createTrackedSession(req,res,account,pool){
 const session=createSession(res,account);
 try{
  const row=await pool.query(`INSERT INTO sdc."USER_SESSIONS"
    ("User_ID","Device_Info","Browser","Started_At","Last_Seen_At","Expires_At","Session_Token_Hash")
    VALUES ($1::bigint,$2::varchar(150),$3::varchar(150),LOCALTIMESTAMP,LOCALTIMESTAMP,LOCALTIMESTAMP + interval '8 hours',$4::varchar(64))
    RETURNING "Session_ID"`,[account.userId,deviceFromAgent(req.headers?.['user-agent']),browserFromAgent(req.headers?.['user-agent']),session.tokenHash]);
  session.sessionId=String(row.rows[0].Session_ID);
  return session;
 }catch(error){sessions.delete(session.tokenHash);setCookie(res,'',0);throw error;}
}
// All browser requests with a session cookie are verified against DB.
// A revoked cookie is denied even across another server process or after restart.
async function restoreTrackedSession(req,res,pool){
 const raw=parseSessionToken(req);
 if(!raw)return null;
 const tokenHash=sessionKey(raw);
 const rs=await pool.query(`SELECT "Session_ID","User_ID","Active_Clinic_ID","Last_Seen_At"
   FROM sdc."USER_SESSIONS" WHERE "Session_Token_Hash"=$1::varchar(64)
   AND "Revoked_At" IS NULL AND "Expires_At">LOCALTIMESTAMP LIMIT 1`,[tokenHash]);
 if(rs.rowCount!==1){sessions.delete(tokenHash);setCookie(res,'',0);return null;}
 const row=rs.rows[0];let session=sessions.get(tokenHash);
 if(session && session.userId!==String(row.User_ID)){sessions.delete(tokenHash);setCookie(res,'',0);return null;}
 if(!session){
  const {loadAccount}=require('./service');
  const actor=await loadAccount(pool,String(row.User_ID),true);
  if(!actor){setCookie(res,'',0);return null;}
  session={userId:actor.userId,role:actor.role,mfaVerified:actor.mfaEnabled,
   clinicId:null,csrf:crypto.createHash('sha256').update('sdc-csrf:'+raw).digest('hex'),
   expires:Date.now()+MAX_AGE_MS,tokenHash};
  sessions.set(tokenHash,session);
 }
 session.sessionId=String(row.Session_ID);
 session.clinicId=row.Active_Clinic_ID==null?null:String(row.Active_Clinic_ID);
 // Throttle last-seen writes; do not log raw UA, cookies, or secrets.
 if(!row.Last_Seen_At || Date.now()-new Date(row.Last_Seen_At).getTime()>5*60*1000){
  await pool.query(`UPDATE sdc."USER_SESSIONS" SET "Last_Seen_At"=LOCALTIMESTAMP
    WHERE "Session_ID"=$1::bigint AND "Revoked_At" IS NULL`,[session.sessionId]);
 }
 return session;
}
async function setTrackedClinic(req,clinicId,pool){
 const session=getSession(req);
 if(!session?.sessionId)throw Error('Session missing');
 await pool.query(`UPDATE sdc."USER_SESSIONS" SET "Active_Clinic_ID"=$2::bigint
 WHERE "Session_ID"=$1::bigint AND "User_ID"=$3::bigint AND "Revoked_At" IS NULL`,
 [session.sessionId,clinicId,session.userId]);
 session.clinicId=String(clinicId);
}
async function listTrackedSessions(pool,userId,currentId){
 const rs=await pool.query(`SELECT "Session_ID","Browser","Device_Info","Started_At","Last_Seen_At","Expires_At"
 FROM sdc."USER_SESSIONS" WHERE "User_ID"=$1::bigint
 AND "Revoked_At" IS NULL AND "Expires_At">LOCALTIMESTAMP
 AND "Session_Token_Hash" IS NOT NULL
 ORDER BY "Started_At" DESC,"Session_ID" DESC LIMIT 50`,[userId]);
 return rs.rows.map(r=>({id:String(r.Session_ID),browser:r.Browser||'متصفح غير معروف',
 device:r.Device_Info||'جهاز غير معروف',startedAt:r.Started_At,lastSeenAt:r.Last_Seen_At,
 expiresAt:r.Expires_At,isCurrent:String(r.Session_ID)===String(currentId)}));
}
function expireReturned(result){
 for(const row of result.rows||[])if(row.Session_Token_Hash)sessions.delete(row.Session_Token_Hash);
}
async function revokeTrackedSession(pool,userId,sessionId){
 const rs=await pool.query(`UPDATE sdc."USER_SESSIONS"
 SET "Revoked_At"=GREATEST("Started_At",LOCALTIMESTAMP)
 WHERE "User_ID"=$1::bigint AND "Session_ID"=$2::bigint
 AND "Session_Token_Hash" IS NOT NULL AND "Revoked_At" IS NULL
 RETURNING "Session_Token_Hash"`,[userId,sessionId]);
 expireReturned(rs);return rs.rowCount===1;
}
async function revokeOtherTrackedSessions(pool,userId,keepSession){
 if(!keepSession?.sessionId)throw Error('Current session not tracked');
 const rs=await pool.query(`UPDATE sdc."USER_SESSIONS"
 SET "Revoked_At"=GREATEST("Started_At",LOCALTIMESTAMP)
 WHERE "User_ID"=$1::bigint AND "Session_ID"<>$2::bigint
 AND "Session_Token_Hash" IS NOT NULL AND "Revoked_At" IS NULL
 RETURNING "Session_Token_Hash"`,[userId,keepSession.sessionId]);
 expireReturned(rs);return rs.rowCount;
}
async function logoutTracked(req,res,pool){
 const session=getSession(req);
 if(session?.sessionId)await revokeTrackedSession(pool,session.userId,session.sessionId);
 dropSession(req,res);
}
module.exports={createTrackedSession,restoreTrackedSession,setTrackedClinic,listTrackedSessions,revokeTrackedSession,revokeOtherTrackedSessions,logoutTracked,revokeUserSessions,createSession,getSession,dropSession,sessionCsrf,validateSessionCsrf,startMfaChallenge,getMfaChallenge,failMfaChallenge,finishMfaChallenge,revokeOtherSessions};
