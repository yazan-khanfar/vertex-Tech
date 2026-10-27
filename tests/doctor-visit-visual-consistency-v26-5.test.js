'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('visit note fields retain their original white visual surface even in read-only completed visits',()=>{
 const css=read('public/doctor/assets/styles.css');
 assert.match(css,/main\[data-booking-id\] #complaint textarea\.form-control\[readonly\][\s\S]*?main\[data-booking-id\] #exam textarea\.form-control\[readonly\][\s\S]*?background-color:\s*#fff/);
 assert.match(css,/main\[data-booking-id\] #exam button\[data-visit-save="findings"\]\.btn-outline-primary:hover\s*\{[^}]*background-color:\s*#fff/);
 assert.match(css,/main\[data-booking-id\] #exam button\[data-visit-save="findings"\]\.btn-outline-primary:hover\s*\{[^}]*color:\s*var\(--brand-700/);
});
test('saved patient clinical findings and teeth remain patient-specific, with no static defaults',()=>{
 const view=read('views/doctor/visit.ejs');
 assert.match(view,/clinical\.findings\.some\(f => f\.finding === "وجود تسوس"\)/);
 assert.match(view,/clinical\.odontogram \|\| \[\]/);
 assert.match(view,/liveVisit\.examination_notes \|\| ""/);
 assert.match(view,/liveVisit\.chief_complaint \|\| ""/);
});
test('completed visit notes stay read-only and approved findings cannot be modified locally',()=>{
 const js=read('public/doctor/assets/visit-bridge.js');
 assert.match(js,/if\(completed\)\{[\s\S]*?x\.readOnly=true/);
 assert.match(js,/x\.setAttribute\('aria-readonly','true'\)/);
 assert.match(js,/if\(approved\)\{[\s\S]*?q\('#exam'\)\?\.querySelectorAll\('input\[name="finding"\]'\)\.forEach\(x=>x\.disabled=true\)/);
 assert.match(js,/if\(!hasVisit\)return notice\('ابدأ الزيارة أولًا/);
 assert.match(js,/if\(approved\)return notice\('التقرير معتمد/);
});
