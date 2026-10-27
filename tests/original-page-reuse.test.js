'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const src=p=>fs.readFileSync(path.join(root,p),'utf8');
test('canonical page inventory has no separately created doctor profile or MFA settings page',()=>{
 const pages=require('../config/page-map.json');
 assert.equal(Object.keys(pages).length,110);
 assert(!fs.existsSync(path.join(root,'views/account/doctor-profile.ejs')));
 assert(!fs.existsSync(path.join(root,'views/auth/security.ejs')));
 assert(!fs.existsSync(path.join(root,'src/account/doctor-profile-router.js')));
 assert(src('server.js').includes("app.get('/account/doctor-profile',(req,res)=>res.redirect(303,'/doctor/profile'))"));
 assert(src('server.js').includes("app.get('/doctor/profile'"));
});
test('clinical visit retains the original 13 section anchors and sidebar with live patient details',()=>{
 const tpl=src('views/doctor/visit.ejs');
 for(const id of ['patient-info','complaint','exam','odontogram','diagnosis','procedure','attachments','plan','prescription','lab','followup','report','doctorInvoiceCard'])
  assert(tpl.includes(`id="${id}"`),`${id} must be present`);
 assert(tpl.includes('class="visit-layout"'));
 assert(tpl.includes('class="visit-sidebar"'));
 assert(tpl.includes('liveVisit.patient_name'));
 assert(tpl.includes('action="/doctor/visit/action"'));
 assert(!tpl.includes('زيارة أحمد خالد'));
 assert(!tpl.includes('A-9022'));
 assert(tpl.includes('id="finishVisitModal"')); // Original modal restored in v26.1
});
test('Super Admin clinic details load live related records; application review keeps its own route',()=>{
 const admin=src('src/admin-review/router.js');
 assert(admin.includes("router.get('/clinic-details'"));
 assert(admin.includes("require('../workspace/admin').clinicDetails"));
 const connected=src('src/workspace/admin.js');
 assert.match(connected,/C\.page\(\s*req,\s*res,\s*['"]admin\/clinic-details['"]/);
 for(const table of ['WORKS_AT','OFFERS','BOOKING'])assert(connected.includes('sdc."'+table+'"'));
 const listing=src('views/admin/approvals.ejs');
 assert(listing.includes('href="/admin/clinic-details?id=<%= clinic.Clinic_ID %>"'));
 assert(listing.includes('href="/admin/clinic-application-details?id=<%= clinic.Clinic_ID %>"'));
 assert(src('views/admin/clinic-details.ejs').includes('liveClinic.Clinic_Name'));
});
test('MFA forms are included in canonical role settings and preserve existing secure POST actions',()=>{
 const p=src('views/partials/shared/mfa-manager.ejs');
 for(const verb of ['start','confirm','cancel','disable'])assert(p.includes(`/auth/security/${verb}`));
 for(const path of ['patient/profile','staff/profile','clinic/account-settings','admin/settings','doctor/profile']){
  assert(src(`views/${path}.ejs`).includes('mfa-manager'),path);
 }
 assert(src('src/mfa/router.js').includes("profilePath(req.sdcActor"));
});
