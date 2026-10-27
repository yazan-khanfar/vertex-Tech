'use strict';
// Single allowlist used for server rendering and request authorization.
// Never infer authority from HTML attributes or client-side JavaScript.
const VIEW_PERMISSIONS=Object.freeze({
 '/appointments':'appointments.view',
 '/patients':'patients.view_admin',
 '/invoices':'invoices.view',
 '/lab-cases':'lab_orders.view',
 '/lab-details':'lab_orders.view',
 '/invoice':'invoices.view',
 '/billing':'invoices.view'
});
const SAFE_ACCOUNT_PAGES=new Set(['/index','/profile','/choose-clinic']);
function parsePermissions(value){
 return new Set(Array.isArray(value)?value.filter(Boolean):String(value||'').split(/\s+/).filter(Boolean));
}
function can(value,permission){return parsePermissions(value).has(permission);}
function accessFor(method,path){
 const verb=String(method||'').toUpperCase();
 if(verb==='GET'||verb==='HEAD'){
  if(SAFE_ACCOUNT_PAGES.has(path))return {publicWithinStaff:true};
  if(Object.prototype.hasOwnProperty.call(VIEW_PERMISSIONS,path))return {permission:VIEW_PERMISSIONS[path]};
  return {deny:true};
 }
 // This existing endpoint also checks appointments.manage and CSRF internally.
 if(verb==='POST'&&path==='/operations/action')return {permission:'appointments.manage'};
 if(verb==='POST'&&path==='/patients/create')return {permission:'patients.create'};
 if(verb==='POST'&&path==='/lab-delivery')return {permission:'lab_orders.update_delivery'};
 if(verb==='POST'&&path==='/billing/create')return {permission:'invoices.issue'};
 if(verb==='POST'&&path==='/billing/action')return {publicWithinStaff:true}; // Specific operation is checked again against sdc_can.
 return {deny:true};
}
module.exports={VIEW_PERMISSIONS,parsePermissions,can,accessFor};
