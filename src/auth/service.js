'use strict';
const {verifyPassword}=require('../security/password');
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function authenticate(pool,email,password){
 if(typeof email!=='string'||typeof password!=='string'||email.length>254||password.length>512)return {status:'invalid'};
 const normalized=email.trim().toLowerCase();
 if(!EMAIL.test(normalized)||!password)return {status:'invalid'};
 const result=await pool.query(`SELECT u."User_ID",u."Password_Hash",u."Account_Status",u."Login_Enabled",u."Two_Factor_Enabled",
   r."Role_Name",r."Role_Scope",d."Doctor_ID",d."License_Status"
   FROM sdc."USER" u JOIN sdc."ROLE" r ON r."Role_ID"=u."Role_ID"
   LEFT JOIN sdc."DOCTOR" d ON d."User_ID"=u."User_ID"
   WHERE lower(btrim(u."Email"))=$1`,[normalized]);
 if(result.rowCount!==1||!result.rows[0].Password_Hash)return {status:'invalid'};
 const user=result.rows[0];
 if(!await verifyPassword(password,user.Password_Hash))return {status:'invalid'};
 if(user.Role_Name==='Doctor'&&user.License_Status!=='verified'){
   return {status:user.License_Status==='pending'?'pending_license':'rejected_license'};
 }
 if(user.Account_Status!=='active'||user.Login_Enabled!==true)return {status:'disabled'};
 let role;
 if(user.Role_Name==='Super Admin'&&user.Role_Scope==='System')role='admin';
 else if(user.Role_Name==='Patient'&&user.Role_Scope==='System')role='patient';
 else if(user.Role_Name==='Doctor'&&user.Role_Scope==='System'&&user.Doctor_ID)role='doctor';
 else if(user.Role_Name==='Staff'&&user.Role_Scope==='System')role='staff';
 else return {status:'unsupported'};
 return {status:user.Two_Factor_Enabled===true?'mfa_required':'ok',userId:String(user.User_ID),role};
}
async function loadAccount(pool,userId,mfaVerified=false){
 if(!/^[1-9]\d{0,18}$/.test(String(userId)))return null;
 const result=await pool.query(`SELECT u."User_ID",u."First_Name",u."Last_Name",u."Account_Status",u."Login_Enabled",u."Two_Factor_Enabled",
  r."Role_Name",r."Role_Scope",d."Doctor_ID",d."License_Status"
  FROM sdc."USER" u JOIN sdc."ROLE" r ON r."Role_ID"=u."Role_ID"
  LEFT JOIN sdc."DOCTOR" d ON d."User_ID"=u."User_ID" WHERE u."User_ID"=$1`,[userId]);
 if(result.rowCount!==1)return null;
 const u=result.rows[0];
 if(u.Account_Status!=='active'||u.Login_Enabled!==true||(u.Two_Factor_Enabled===true&&!mfaVerified))return null;
 const role=u.Role_Name==='Super Admin'&&u.Role_Scope==='System'?'admin':
 u.Role_Name==='Patient'&&u.Role_Scope==='System'?'patient':
 u.Role_Name==='Doctor'&&u.Role_Scope==='System'&&u.License_Status==='verified'&&u.Doctor_ID?'doctor':
 u.Role_Name==='Staff'&&u.Role_Scope==='System'?'staff':null;
 return role?{role,userId:String(userId),mfaEnabled:u.Two_Factor_Enabled===true,doctorId:u.Doctor_ID?String(u.Doctor_ID):null,fullName:(u.First_Name+' '+u.Last_Name).trim()}:null;
}
async function clinicsFor(pool,actor){
 if(actor.role==='doctor'){
  const rs=await pool.query(`SELECT c."Clinic_ID",c."Clinic_Name",c."Manager_Doctor_ID"=$1::bigint AS manager
   FROM sdc."CLINIC" c WHERE c."Clinic_Status"='active' AND c."Approval_Status"='approved'
   AND (c."Manager_Doctor_ID"=$1::bigint OR EXISTS (SELECT 1 FROM sdc."WORKS_AT" w
   WHERE w."Clinic_ID"=c."Clinic_ID" AND w."Doctor_ID"=$1::bigint AND w."Membership_Status"='active' AND w."Start_Date"<=CURRENT_DATE))
   ORDER BY c."Clinic_Name",c."Clinic_ID"`,[actor.doctorId]);
  return rs.rows.map(r=>({id:String(r.Clinic_ID),name:r.Clinic_Name,manager:r.manager===true,role:'doctor'}));
 }
 if(actor.role==='staff'){
  const rs=await pool.query(`SELECT c."Clinic_ID",c."Clinic_Name",s."Role_ID" FROM sdc."STAFF_AT" s
   JOIN sdc."CLINIC" c ON c."Clinic_ID"=s."Clinic_ID"
   WHERE s."User_ID"=$1 AND s."Membership_Status"='active'
    AND c."Clinic_Status"='active' AND c."Approval_Status"='approved'
   ORDER BY c."Clinic_Name",c."Clinic_ID"`,[actor.userId]);
  return rs.rows.map(r=>({id:String(r.Clinic_ID),name:r.Clinic_Name,manager:false,role:'staff'}));
 }
 return [];
}
function redirectFor(actor,clinics){
 if(actor.role==='admin')return '/admin/index';
 if(actor.role==='patient')return '/patient/index';
 if(actor.role==='doctor'){
  if(!clinics.length)return '/onboarding/doctor/choose-path';
  if(clinics.length>1)return '/account/context';
  return '/doctor/index';
 }
 if(actor.role==='staff')return clinics.length===1?'/staff/index':'/staff/choose-clinic';
 return '/auth/login';
}
module.exports={authenticate,loadAccount,clinicsFor,redirectFor};
