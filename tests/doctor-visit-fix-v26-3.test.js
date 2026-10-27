'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=(name)=>fs.readFileSync(path.join(root,name),'utf8');
test('legacy doctor-app prescription handlers skip the server-backed visit',()=>{
 const app=read('public/doctor/assets/app.js');
 assert.match(app,/data-add-prescription[\s\S]{0,125}closest\('main\[data-booking-id\]\[data-clinical-enabled\]'\)/);
 assert.match(app,/data-remove-medication[\s\S]{0,150}closest\('main\[data-booking-id\]\[data-clinical-enabled\]'\)/);
 const bridge=read('public/doctor/assets/visit-bridge.js');
 assert.match(bridge,/data-add-prescription[\s\S]{0,105}stopPropagation\(\)/);
 assert.match(bridge,/data-remove-medication[\s\S]{0,105}stopPropagation\(\)/);
});
test('stage opening routes to the actual treatment plan and not the patient first plan',()=>{
 assert.match(read('src/doctor-workspace/clinical-service.js'),/st\."Plan_ID"::text plan_id/);
 const view=read('views/doctor/visit.ejs');
 assert.match(view,/doctor\/treatment-plan-details\?id=<%= st\.plan_id %>/);
 assert.doesNotMatch(view,/clinical\.plans\[0\]\.id/);
});
test('patient summary does not repeat health notes and loads current meds and allergies',()=>{
 const view=read('views/doctor/visit.ejs');
 assert.match(view,/liveVisit\.current_medications/);
 assert.match(view,/liveVisit\.allergies/);
 assert.match(read('src/daily-operations/service.js'),/FROM sdc\."PATIENT_CURRENT_MEDICATIONS"/);
 assert.match(read('src/daily-operations/service.js'),/FROM sdc\."PATIENT_ALLERGIES"/);
 assert.equal((view.match(/<span class="text-secondary">ملاحظات صحية<\/span>/g)||[]).length,1);
});
test('follow-up description complete and clinical finding label points to existing id',()=>{
 const view=read('views/doctor/visit.ejs');
 assert.match(view,/for="field-2"><input[^>]*id="field-2"/);
 assert.doesNotMatch(view,/for="field-8"/);
 assert.match(view,/تم الحجز/);
 assert.doesNotMatch(view,/إذا حجز المريض أو\s*<\/div>/);
});
