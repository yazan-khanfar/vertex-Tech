'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../views/doctor/visit.ejs'),'utf8');
const js=fs.readFileSync(path.join(__dirname,'../public/doctor/assets/visit-bridge.js'),'utf8');
test('restores all original visit sections without creating alternate visit page',()=>{
 const expected=['patient-info','complaint','exam','odontogram','diagnosis','procedure','attachments','plan','prescription','lab','followup','report','doctorInvoiceCard'];
 const found=[...html.matchAll(/class="clinical-card clinical-section mb-4" id="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(found,expected);
 assert.equal((html.match(/class="tooth"/g)||[]).length,32);
 assert.match(html,/id="finishVisitModal"/);
 assert.match(html,/id="saveVisitDraft"/);
 assert.match(html,/id="finishVisit"/);
 assert.match(html,/id="sdcProcedure"/);
 assert.match(html,/id="medicationList"/);
});
test('preserves existing routes and CSRF protection',()=>{
 for(const endpoint of ['/doctor/visit/action','/doctor/visit/clinical/action','/doctor/visit/report/approve'])assert.ok(html.includes(endpoint),endpoint);
 assert.match(html,/name="csrf_token"/);
 assert.match(html,/data-clinical-enabled/);
 assert.match(js,/tooth_number/);
 assert.match(js,/diagnosis/);
 assert.match(js,/prescription/);
 assert.match(js,/followup/);
});
test('removes patient-specific static examples from original mock visit',()=>{
 for(const example of ['أحمد خالد','A-9022','S-001','V-002','Elite Dental Lab','xray_tooth_46_before.jpg'])assert.ok(!html.includes(example),example);
});
