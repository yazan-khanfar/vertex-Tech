'use strict';
// Explicit one-time local bootstrap. Never seeds a hardcoded/default password.
const fs=require('node:fs');const path=require('node:path');
const env=path.join(__dirname,'..','.env');if(fs.existsSync(env))process.loadEnvFile(env);
const {getPool}=require('../db/pool');const {hashPassword}=require('../src/security/password');
const readline=require('node:readline');
async function askText(question){
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});
 try{return await new Promise(resolve=>rl.question(question,resolve));}
 finally{rl.close();}
}
async function askPassword(question){
 if(!process.stdin.isTTY||typeof process.stdin.setRawMode!=='function')throw new Error('Interactive password input requires a terminal. Or set SDC_ADMIN_PASSWORD in this shell.');
 process.stdout.write(question);
 return new Promise((resolve,reject)=>{
  let pw='';process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  const onKey=chunk=>{for(const ch of chunk){
   if(ch==='\r'||ch==='\n'){end();resolve(pw);return;}
   if(ch==='\u0003'){end();reject(new Error('Aborted by user'));return;}
   if(ch==='\u007f'||ch==='\b'){pw=pw.slice(0,-1);continue;}
   if(ch>=' '&&ch!=='\u007f')pw+=ch;
  }};
  function end(){process.stdin.off('data',onKey);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}
  process.stdin.on('data',onKey);
 });
}

async function main(){
 const email=String(process.env.SDC_ADMIN_EMAIL || (process.stdin.isTTY ? await askText('Super Admin email: ') : '')).trim().toLowerCase();
 const phone=String(process.env.SDC_ADMIN_PHONE || (process.stdin.isTTY ? await askText('Super Admin phone: ') : '')).trim();
 const password=process.env.SDC_ADMIN_PASSWORD || (process.stdin.isTTY ? await askPassword('Super Admin password (hidden, 14+ characters): ') : '');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<14||password.length>128||phone.length<7||phone.length>30){
  throw new Error('A valid email, phone (7-30 chars), and password (14-128 chars) are required. Use interactive terminal or SDC_ADMIN_* environment variables.');
 }
 const pool=getPool();const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const existing=await client.query(`SELECT u."User_ID" FROM sdc."USER" u JOIN sdc."ROLE" r ON r."Role_ID"=u."Role_ID" WHERE r."Role_Name"='Super Admin' AND r."Role_Scope"='System'`);
  if(existing.rowCount)throw new Error('A Super Admin already exists. Bootstrap refuses duplicate creation.');
  await client.query(`INSERT INTO sdc."ROLE"("Role_Name","Role_Scope") VALUES('Super Admin','System') ON CONFLICT ("Role_Name","Role_Scope") DO NOTHING`);
  const result=await client.query(`INSERT INTO sdc."USER"
   ("First_Name","Last_Name","Email","Phone","Password_Hash","Account_Status","Created_At","Preferred_Language","Two_Factor_Enabled","Login_Enabled","Role_ID")
   SELECT 'System','Admin',$1,$2,$3,'active',LOCALTIMESTAMP,'ar',false,true,r."Role_ID"
   FROM sdc."ROLE" r WHERE r."Role_Name"='Super Admin' AND r."Role_Scope"='System' RETURNING "User_ID"`,
   [email,phone,await hashPassword(password)]);
  if(result.rowCount!==1)throw new Error('Super Admin role was not found.');
  await client.query('COMMIT');console.log('Super Admin account created:',email,'User_ID:',result.rows[0].User_ID);
 }catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();await pool.end();}
}
main().catch(e=>{console.error('Super Admin bootstrap failed:',e.message);process.exitCode=1;});
