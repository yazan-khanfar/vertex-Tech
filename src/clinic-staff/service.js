'use strict';
// Staff is a separate System role. Permissions and Clinic role are scoped to
// STAFF_AT / STAFF_PERMISSIONS; no staff account gets doctor-only privileges.
const {hashPassword}=require('../security/password');
const {revokeUserSessions}=require('../auth/session');
const ID=/^[1-9]\d{0,17}$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES=Object.freeze({reception:{name:'Receptionist',label:'منسق استقبال'},accountant:{name:'Accountant',label:'محاسب'},coordinator:{name:'Coordinator',label:'منسق عيادة'}});
const PERMISSIONS=Object.freeze(['appointments.view','appointments.manage','patients.view_admin','patients.create','invoices.view','payments.record','reports.view_operational','lab_orders.view','lab_orders.update_delivery','laboratories.manage','invoices.issue']);
const ALLOWED=new Set(PERMISSIONS);
function validate(body,editing=false){
 const role=String(body?.clinic_role_id||'');const status=String(body?.staff_form_status||'');
 const raw=body?.['permissions[]']??body?.permissions??[];
 const perms=Array.isArray(raw)?raw:[raw];
 if(!Object.hasOwn(ROLES,role)||!['active','suspended'].includes(status)||perms.some(x=>typeof x!=='string'||!ALLOWED.has(x))||new Set(perms).size!==perms.length)return null;
 if(editing)return {role,status,permissions:perms};
 const name=String(body?.staff_form_name||'').trim().replace(/\s+/g,' ');
 const email=String(body?.staff_form_email||'').trim().toLowerCase();const phone=String(body?.staff_form_phone||'').trim();
 const pass=body?.password;const confirm=body?.password_confirmation;
 const parts=name.split(' ');
 if(parts.length<2||name.length>300||parts[0].length>150||parts.slice(1).join(' ').length>150||!EMAIL.test(email)||email.length>254||phone.length<7||phone.length>30||typeof pass!=='string'||pass.length<12||pass.length>128||pass!==confirm||body?.account_mode!=='create')return null;
 return {role,status,permissions:perms,first:parts[0],last:parts.slice(1).join(' '),email,phone,password:pass};
}
async function list(pool,clinic){
 const rs=await pool.query(`SELECT s."User_ID"::text AS id,u."First_Name"||' '||u."Last_Name" AS name,u."Email" AS email,u."Phone" AS phone,
 s."Membership_Status" AS status,r."Role_Name" AS role_name,
 COALESCE(array_agg(p."Permission_Code" ORDER BY p."Permission_Code") FILTER (WHERE p."Permission_Code" IS NOT NULL),ARRAY[]::varchar[]) AS permissions
 FROM sdc."STAFF_AT" s JOIN sdc."USER" u ON u."User_ID"=s."User_ID" JOIN sdc."ROLE" r ON r."Role_ID"=s."Role_ID"
 LEFT JOIN sdc."STAFF_PERMISSIONS" p ON p."User_ID"=s."User_ID" AND p."Clinic_ID"=s."Clinic_ID"
 WHERE s."Clinic_ID"=$1::bigint GROUP BY s."User_ID",u."First_Name",u."Last_Name",u."Email",u."Phone",s."Membership_Status",r."Role_Name"
 ORDER BY u."First_Name",u."Last_Name" LIMIT 500`,[clinic]);
 const reverse=Object.fromEntries(Object.entries(ROLES).map(([k,v])=>[v.name,k]));
 return rs.rows.map(x=>({...x,role:reverse[x.role_name]||'coordinator',roleLabel:ROLES[reverse[x.role_name]]?.label||x.role_name}));
}
async function assertManager(db,clinic,user){
 const rs=await db.query(`SELECT 1 FROM sdc."CLINIC" c JOIN sdc."DOCTOR" d ON d."Doctor_ID"=c."Manager_Doctor_ID"
 WHERE c."Clinic_ID"=$1::bigint AND d."User_ID"=$2::bigint AND c."Clinic_Status"='active' AND c."Approval_Status"='approved' FOR UPDATE OF c`,[clinic,user]);
 return rs.rowCount===1;
}
async function ensureRole(db,scope,name){
 await db.query(`INSERT INTO sdc."ROLE"("Role_Name","Role_Scope") VALUES($1::varchar(150),$2::varchar(150)) ON CONFLICT("Role_Name","Role_Scope") DO NOTHING`,[name,scope]);
 const r=await db.query(`SELECT "Role_ID" FROM sdc."ROLE" WHERE "Role_Name"=$1::varchar(150) AND "Role_Scope"=$2::varchar(150)`,[name,scope]);
 if(r.rowCount!==1)throw Error('Role unavailable');return r.rows[0].Role_ID;
}
async function save(pool,clinic,managerUser,body){
 if(!ID.test(String(clinic))||!ID.test(String(managerUser)))return {status:'forbidden'};
 const action=String(body?.action||'create');if(!['create','update','suspend','activate','archive'].includes(action))return {status:'invalid'};
 const editing=action!=='create';const p=['create','update'].includes(action)?validate(body,editing):null;
 if(['create','update'].includes(action)&&!p)return {status:'invalid'};
 const target=String(body?.staff_id||'');if(editing&&!ID.test(target))return {status:'invalid'};
 // Perform hashing before opening the DB transaction; never log credentials.
 const hash=action==='create'?await hashPassword(p.password):null;
 const db=await pool.connect();let changed=null;
 try{
  await db.query('BEGIN');await db.query("SELECT set_config('sdc.user_id',$1,true)",[managerUser]);
  if(!await assertManager(db,clinic,managerUser)){await db.query('ROLLBACK');return {status:'forbidden'};}
  let user=target;
  if(action==='create'){
   const exists=await db.query(`SELECT 1 FROM sdc."USER" WHERE lower(btrim("Email"))=$1::varchar(254) LIMIT 1`,[p.email]);
   if(exists.rowCount){await db.query('ROLLBACK');return {status:'duplicate'};}
   const systemRole=await ensureRole(db,'System','Staff');
   const created=await db.query(`INSERT INTO sdc."USER"("First_Name","Last_Name","Email","Phone","Password_Hash","Account_Status","Created_At","Preferred_Language","Two_Factor_Enabled","Login_Enabled","Role_ID")
      VALUES($1::varchar(150),$2::varchar(150),$3::varchar(254),$4::varchar(30),$5::varchar(512),'active',LOCALTIMESTAMP,'ar',false,true,$6::bigint) RETURNING "User_ID"`,[p.first,p.last,p.email,p.phone,hash,systemRole]);
   user=String(created.rows[0].User_ID);
  }else{
   const current=await db.query(`SELECT s."Membership_Status" AS status FROM sdc."STAFF_AT" s WHERE s."User_ID"=$1::bigint AND s."Clinic_ID"=$2::bigint FOR UPDATE`,[user,clinic]);
   if(current.rowCount!==1){await db.query('ROLLBACK');return {status:'not_found'};}
   if(action==='activate'&&current.rows[0].status!=='suspended'||action==='suspend'&&current.rows[0].status!=='active'||action==='archive'&&current.rows[0].status==='inactive'){
    await db.query('ROLLBACK');return {status:'stale'};
   }
  }
  if(action==='create'||action==='update'){
   const clinicRole=await ensureRole(db,'Clinic',ROLES[p.role].name);
   if(action==='create')await db.query(`INSERT INTO sdc."STAFF_AT"("Membership_Status","User_ID","Clinic_ID","Role_ID") VALUES($1::varchar(150),$2::bigint,$3::bigint,$4::bigint)`,[p.status,user,clinic,clinicRole]);
   else await db.query(`UPDATE sdc."STAFF_AT" SET "Membership_Status"=$3::varchar(150),"Role_ID"=$4::bigint WHERE "User_ID"=$1::bigint AND "Clinic_ID"=$2::bigint`,[user,clinic,p.status,clinicRole]);
   // Replace only this staff member's permissions *inside this clinic*.
   await db.query(`DELETE FROM sdc."STAFF_PERMISSIONS" WHERE "User_ID"=$1::bigint AND "Clinic_ID"=$2::bigint`,[user,clinic]);
   for(const code of p.permissions)await db.query(`INSERT INTO sdc."STAFF_PERMISSIONS"("Permission_Code","User_ID","Clinic_ID") VALUES($1::varchar(150),$2::bigint,$3::bigint)`,[code,user,clinic]);
  }else{
   const status=action==='suspend'?'suspended':action==='activate'?'active':'inactive';
   await db.query(`UPDATE sdc."STAFF_AT" SET "Membership_Status"=$3::varchar(150) WHERE "User_ID"=$1::bigint AND "Clinic_ID"=$2::bigint`,[user,clinic,status]);
  }
  await db.query(`INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,$1::varchar(150),'Staff',$2::varchar(512),$3::text,$4::bigint)`,[`clinic.staff.${action}`,user,`إدارة موظف في العيادة ${clinic}`,managerUser]);
  if(action==='create')await db.query(`INSERT INTO sdc."NOTIFICATION"("Title","Body","Notification_Type","Created_At","Target_Type","Target_Reference","User_ID") VALUES('تم إنشاء حساب موظف','أصبح لديك حساب موظف في العيادة. غيّر كلمة المرور عند أول دخول، وفعّل التحقق الثنائي.','staff.account.created',LOCALTIMESTAMP,'Clinic',$1::varchar(512),$2::bigint)`,[clinic,user]);
  // Invalidate all active sessions only after an existing user's access changes;
  // queries/guard on each request also enforce currently active memberships.
  if(editing)await db.query(`UPDATE sdc."USER_SESSIONS" SET "Revoked_At"=GREATEST("Started_At",LOCALTIMESTAMP)
   WHERE "User_ID"=$1::bigint AND "Revoked_At" IS NULL`,[user]);
  await db.query('COMMIT');changed=editing?user:null;
  return {status:'ok',id:user};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});if(e.code==='23505')return {status:'duplicate'};throw e;}finally{db.release();if(changed)revokeUserSessions(changed);}
}
module.exports={ROLES,PERMISSIONS,validate,list,save};
