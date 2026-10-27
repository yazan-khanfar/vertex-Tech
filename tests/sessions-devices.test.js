'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const session=require('../src/auth/session');
function response(){return {cookies:[],append(name,value){if(name==='Set-Cookie')this.cookies.push(value);}};}
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
function store(){
 const rows=new Map();let next=1;const calls=[];
 const pool={async query(sql,params){calls.push({sql,params});
  if(sql.includes('FROM sdc."USER" u JOIN sdc."ROLE" r')){
   return {rowCount:1,rows:[{User_ID:params[0],First_Name:'Sample',Last_Name:'User',Account_Status:'active',Login_Enabled:true,Two_Factor_Enabled:true,Role_Name:'Patient',Role_Scope:'System',Doctor_ID:null,License_Status:null}]};
  }
  if(sql.includes('INSERT INTO sdc."USER_SESSIONS"')){
   const id=String(next++);
   rows.set(id,{Session_ID:id,User_ID:String(params[0]),Device_Info:params[1],Browser:params[2],Session_Token_Hash:params[3],Active_Clinic_ID:null,Last_Seen_At:new Date(),Started_At:new Date(),Expires_At:new Date(Date.now()+8*3600000),Revoked_At:null});
   return {rowCount:1,rows:[{Session_ID:id}]};
  }
  if(sql.includes('SELECT "Session_ID","User_ID","Active_Clinic_ID"')){
   const r=[...rows.values()].find(r=>r.Session_Token_Hash===params[0]&&!r.Revoked_At);
   return {rowCount:r?1:0,rows:r?[r]:[]};
  }
  if(sql.includes('FROM sdc."USER_SESSIONS" WHERE "User_ID"')){
   const found=[...rows.values()].filter(r=>r.User_ID===String(params[0])&&!r.Revoked_At);
   return {rowCount:found.length,rows:found};
  }
  if(sql.includes('SET "Revoked_At"')){
   const matched=[...rows.values()].filter(r=>r.User_ID===String(params[0])&&!r.Revoked_At&&r.Session_Token_Hash&&(sql.includes('<>')?r.Session_ID!==String(params[1]):r.Session_ID===String(params[1])));
   for(const r of matched)r.Revoked_At=new Date();
   return {rowCount:matched.length,rows:matched.map(r=>({Session_Token_Hash:r.Session_Token_Hash}))};
  }
  if(sql.includes('SET "Active_Clinic_ID"')){
   const r=rows.get(String(params[0]));if(r&&r.User_ID===String(params[2]))r.Active_Clinic_ID=params[1];return {rowCount:r?1:0,rows:[]};
  }
  if(sql.includes('SET "Last_Seen_At"'))return {rowCount:1,rows:[]};
  throw Error('Unexpected query: '+sql);
 }};
 return {pool,rows,calls};
}
function reqFrom(res){const raw=res.cookies.find(x=>x.startsWith('sdc_session='));return {headers:{cookie:raw.split(';')[0]},body:{}};}
test('track sessions using SHA-256 hash only and current-user-scoped listing',async()=>{
 const db=store();const r1=response(),r2=response(),r3=response();
 const s1=await session.createTrackedSession({headers:{'user-agent':ua}},r1,{userId:'201',role:'patient',mfaVerified:true},db.pool);
 const s2=await session.createTrackedSession({headers:{'user-agent':'Mozilla Android Firefox/100.0'}},r2,{userId:'201',role:'patient',mfaVerified:true},db.pool);
 const other=await session.createTrackedSession({headers:{}},r3,{userId:'202',role:'admin',mfaVerified:true},db.pool);
 const token=r1.cookies[0].split(';')[0].split('=')[1];
 assert(![...db.calls].some(c=>JSON.stringify(c.params).includes(token)),'raw bearer secret must never reach SQL');
 assert.match(s1.tokenHash,/^[a-f0-9]{64}$/);
 assert.equal(db.rows.get(s1.sessionId).Browser,'Microsoft Edge');
 const displayed=await session.listTrackedSessions(db.pool,'201',s1.sessionId);
 assert.equal(displayed.length,2);assert(displayed.find(x=>x.id===s1.sessionId).isCurrent);
 assert(!displayed.some(x=>x.id===other.sessionId),'never list other accounts');
 const fake=await session.revokeTrackedSession(db.pool,'202',s2.sessionId);
 assert.equal(fake,false,'foreign sessions cannot be revoked');
 const updated=await session.revokeOtherTrackedSessions(db.pool,'201',s1);
 assert.equal(updated,1);assert(session.getSession(reqFrom(r1)),'own current session must survive');
 assert.equal(session.getSession(reqFrom(r2)),null,'other sessions invalidated in memory');
 assert.equal((await session.listTrackedSessions(db.pool,'201',s1.sessionId)).length,1);
 await session.setTrackedClinic(reqFrom(r1),'45',db.pool);
 assert.equal(db.rows.get(s1.sessionId).Active_Clinic_ID,'45');
 await session.revokeTrackedSession(db.pool,'201',s1.sessionId);
 assert.equal(session.getSession(reqFrom(r1)),null);
 assert.equal(await session.restoreTrackedSession(reqFrom(r1),response(),db.pool),null,'revoked cookie cannot restore');
});
test('DB-backed cookie can restore after local process state is cleared',async()=>{
 const db=store(),out=response();
 await session.createTrackedSession({headers:{}},out,{userId:'777',role:'patient',mfaVerified:true},db.pool);
 const req=reqFrom(out);
 const before=session.sessionCsrf(req);
 session.revokeUserSessions('777'); // clears in-memory cache but must not revoke row in this test
 assert.equal(session.getSession(req),null);
 const restored=await session.restoreTrackedSession(req,response(),db.pool);
 assert(restored);
 assert.equal(restored.role,'patient');
 assert.equal(session.sessionCsrf(req),before,'CSRF value remains session bound after restart');
 session.revokeUserSessions('777');
});
test('tracked logout expires cookie and revokes DB row',async()=>{
 const db=store(),res=response();const s=await session.createTrackedSession({headers:{}},res,{userId:'303',role:'patient'},db.pool);
 const req=reqFrom(res),r2=response();
 await session.logoutTracked(req,r2,db.pool);
 assert(db.rows.get(s.sessionId).Revoked_At);
 assert.equal(session.getSession(req),null);
 assert(r2.cookies.some(x=>x.startsWith('sdc_session=;')));
});
test('login query explicitly binds account, role and device without storing full user agent',async()=>{
 const s=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/auth/session.js'),'utf8');
 assert(s.includes('"Session_Token_Hash"'));
 assert(s.includes('"Session_ID"=$2::bigint'));
 assert(s.includes('"User_ID"=$1::bigint'));
 assert(s.includes('"Revoked_At" IS NULL'));
});
