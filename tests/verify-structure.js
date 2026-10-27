'use strict';
/* Offline template-and-assets smoke test (does not require npm dependencies).
 * This checks syntax of EJS directives used by the UI scaffold and that
 * converted pages and shared includes are resolvable. Integration tests for
 * Express, database, authentication and browser must be added separately.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
const viewRoot = path.join(project, 'views');
const entries = require('../config/page-map.json');
function render(file, locals, depth=0) {
  assert(depth < 14, `Recursive EJS include: ${file}`);
  assert(file.startsWith(viewRoot + path.sep), `Unsafe view reference: ${file}`);
  const source = fs.readFileSync(file, 'utf8');
  const regex = /<%([=-]?)([\s\S]*?)%>/g;
  let i=0, match, program='let output="";\n';
  function literal(text) { if (text) program += 'output += ' + JSON.stringify(text) + ';\n'; }
  while ((match=regex.exec(source))) {
    literal(source.slice(i, match.index));
    program += match[1] ? 'output += (' + match[2] + ');\n' : match[2] + '\n';
    i=match.index+match[0].length;
  }
  literal(source.slice(i));
  program+='return output;';
  const include = (name, additions={}) => render(path.resolve(path.dirname(file), name + '.ejs'), {...locals,...additions}, depth+1);
  return new Function('locals', 'include', `with (locals) { ${program} }`)(locals, include);
}
function checkLocalAssets(html, page) {
  const pathRef = /<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"]+)"/ig;
  const origin='http://localhost:3000/';
  let match;
  while ((match=pathRef.exec(html))) {
    const link=match[1];
    if (/^(?:https?:|data:|#|\/\/)/i.test(link)) continue;
    const url = new URL(link, origin+page);
    const dest=path.resolve(project,'public', decodeURIComponent(url.pathname.replace(/^\//,'')));
    assert(dest.startsWith(path.join(project,'public')+path.sep),`Bad asset path: ${page} ${link}`);
    assert(fs.existsSync(dest),`Missing asset: ${page} -> ${link}`);
  }
}
const knownRoutes = new Set(Object.keys(entries).map(p => '/' + p.replace(/\.html$/, '')));
knownRoutes.add('/');
knownRoutes.add('/admin/sign-in');
knownRoutes.add('/auth/logout');
knownRoutes.add('/admin/system-log/export');
knownRoutes.add('/auth/security');
knownRoutes.add('/auth/change-password');
knownRoutes.add('/account/doctor-profile'); // legacy alias redirects to the canonical doctor profile
knownRoutes.add('/onboarding/doctor/clinic/document/1');
knownRoutes.add('/admin/clinic-document/1');
for (const route of ['/clinic/billing','/clinic/invoice','/account/profile','/account/notifications','/account/support']) knownRoutes.add(route);
knownRoutes.add('/clinic/document/1');
let pageLinksChecked = 0;
function checkPageLinks(html, page) {
  const base = 'http://localhost:3000/' + page.replace(/\.html$/, '');
  const anchors = /<a\b[^>]*?\bhref=["']([^"']+)["']/gi;
  let match;
  while ((match = anchors.exec(html))) {
    const link = match[1].replace(/&amp;/g, '&');
    if (!link || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(link)) continue;
    const url = new URL(link, base);
    if (url.origin !== 'http://localhost:3000') continue;
    if (url.pathname.startsWith('/assets/') || url.pathname.match(/\.(?:png|jpg|jpeg|svg|pdf|webp|css|js)$/)) continue;
    assert(knownRoutes.has(url.pathname), `Unknown page link in ${page}: ${link}`);
    pageLinksChecked++;
  }
}
let count=0;
for (const [page, item] of Object.entries(entries)) {
  const cls = kind => index => item[kind+'ActiveClasses'][index] ? ' '+item[kind+'ActiveClasses'][index] : '';
  const current = kind => index => item[kind+'Aria'][index] === 'page' ? ' aria-current="page"' : '';
  const content=render(path.join(viewRoot, item.view + '.ejs'), {
    ...item,
    labels:{pending:'بانتظار الموافقة',confirmed:'مؤكد'},now:{date:'2026-10-26',time:'10:00'},message:'',
    stock:{items:[],movements:[],stats:{total:0,low:0,empty:0,expiring:0}},finance:{items:[],stats:{count:0,paid:0,partial:0,unpaid:0}},settlements:[],
    dashboard:{clinic:{id:'1',name:'عيادة اختبار'},dateLabel:'الاثنين، 26 أكتوبر 2026',open:true,clinicHoursLabel:'9:00 ص – 5:00 م',stats:{today:0,confirmed:0,waiting:0,completed:0,pendingApprovals:0,doctorCount:0,unpaidInvoices:0},appointments:[],alerts:[],doctors:[]},
    overview:{identity:{name:'طبيب اختبار',clinic:'عيادة اختبار'},date:'2026-10-27',today:[],stats:{today:0,completed:0,pending_reports:0,followups:0,labs:0}},followups:[],reports:[],
    followUpVisitId:'',plans:[],recalls:[],plan:{id:'1',title:'خطة تجريبية',status:'active',status_label:'نشطة',patient_id:'1',patient_name:'مريض تجربة',doctor_id:'1',doctor_name:'طبيب تجربة',start_date:'2026-10-21',cost:'100',progress:0,notes:'',stages:[],next:null},visit:{id:'1',patient_id:'1',patient_name:'مريض تجربة',doctor_name:'طبيب تجربة',service_name:'فحص',duration:30,date:'2026-10-21',time:'10:00',price:'100',approved:false,follow_type:null,follow_date:null,follow_booking_id:null},report:{id:'1',patient_id:'1',patient_name:'مريض تجربة',doctor_name:'طبيب تجربة',service_name:'فحص',date:'2026-10-21',complaint:'فحص',examination:'',recommendations:'',follow_type:null,follow_date:null,diagnoses:[],procedures:[],medications:[],files:[]},
    entries:[],counters:{arrived:0,waiting:0,treating:0,noShow:0},today:"2026-10-26",visitMessage:"",rows:[],clinicServices:[],selection:{clinic_id:'',doctor_id:'',service_id:'',appointment_date:''},selected:null,timeSlots:[],availabilityMessage:'',patients:[],selectedPatientId:"",patient:{id:'1',name:'مريض اختبار',phone:'0590000000',email:null,dob:'1999-05-10',gender:'male',blood:'unknown',notes:'لا توجد معلومات صحية مسجلة',allergies:[],chronic:[],meds:[],medications:[],visits:[],plans:[],invoices:[],bill:{total:0,remaining:0}},bookings:[],services:[],staff:[],specialties:[],WEEKDAYS:['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'],
    profile:{person:{id:'1',name:'طبيب اختبار',specialties:'طب الأسنان',start_date:'2026-10-01'},periods:[],absences:[],services:[]},
    booking:{id:'1',status:'pending',clinic_name:'عيادة اختبار',doctor_name:'طبيب اختبار',patient_name:'مريض اختبار',service_name:'فحص',date:'2026-10-27',time:'09:00',duration:30,price:'100',notes:'',request_status:null,requested_date:null,requested_time:null},
    // The clinic batch-4 templates use real server data in production; the
    // structure smoke test uses empty records to compile those templates offline.
    labs:[],catalogue:[],counts:{active:0,archived:0,opened:0,overdue:0},
    lab:{Laboratory_ID:1,Laboratory_Name:'مختبر تجريبي',Address:'',Phone:'',Relationship_Status:'active',Internal_Notes:''},
    cases:[],targetLabs:[],visits:[],jobs:[],applicants:[],attachments:[],
    label:v=>v,specialties:[],
    application:{Application_ID:1,Application_Status:'pending',Full_Name:'',Email:'',Phone:'',Residence_City:'',Specialty_Name:'',License_Number:'',License_Status:'verified',Years_Of_Experience:0,Expected_Salary:null,Applied_At:new Date(),Job_Title:'',Job_ID:1,Employment_Type:'full_time',Minimum_Experience_Years:0,City:'',Cover_Letter:'',Clinic_Feedback:'',Internal_Notes:'',Doctor_ID:1},
    analytics:{period:{kind:'month',from:'2026-10-01',displayTo:'2026-10-27'},money:x=>String(x),finance:{billed:0,collected:0,remaining:0,pct:0,paid_count:0,partial_count:0,unpaid_count:0},booking:{total:0,completed:0,cancelled:0,no_show:0,pending:0,reschedule:0},patient:{active:0,new:0},followup:{waiting:0,overdue:0},doctors:[],services:[],months:[],lab:{labs:0,opened:0,overdue:0},jobs:{jobs:0,applicants:0},quality:{average:0,busiest:'—'}},
    navActiveClass: cls('nav'), navAriaCurrent: current('nav'),
    drawerActiveClass: cls('drawer'), drawerAriaCurrent: current('drawer'),
    accountUser:{Email:'manager@example.invalid',Phone:'0599000000',Preferred_Language:'ar'},accountSettingsAlert:'',accountSettingsOk:false,accountSessions:[],sessionActionCsrf:'test-token',sessionActionMessage:'',adminCsrfToken:'test-token', passwordChangeCsrf:'test-token', passwordChangeError:'', logoutCsrf:'test-token', loginCsrf:'test-token',loginError:'',loginEmail:'',mfaError:'',clinics:[],clinic:{Clinic_ID:'1',Clinic_Name:'عيادة تجربة',City:'جنين',Area:'الوسط',Clinic_Phone:'0590000000',Clinic_Email:'test@example.invalid',Facility_License_Number:'test-001',Address_Text:'جنين',Latitude:32.45,Longitude:35.29,Submitted_At:new Date(),First_Name:'تجربة',Last_Name:'طبيب',Application_Notes:'',Review_Notes:null,Approval_Status:'pending'},documents:[],status:'pending',feedback:'',reviewResult:'',reviewError:'',editing:false,csrfToken:'test-token',contextError:'',mode:'doctor',currentUser:{fullName:'شخص تجريبي'},activeClinic:{id:'1',name:'عيادة اختبار'}, doctorAccount:{First_Name:'طبيب',Last_Name:'تجربة',Email:'doc@example.invalid',Phone:'0599000000',License_Number:'LIC-123',License_Status:'verified',specialties:[{Name_AR:'طب الأسنان العام'}]}, mfaView:{enabled:false,secret:null,uri:null,csrfToken:'test-token',message:'',error:'',codes:null}, liveClinic:{Clinic_ID:1,Clinic_Name:'عيادة اختبار',Clinic_Status:'active',First_Name:'طبيب',Last_Name:'تجربة',City:'جنين',Clinic_Phone:'0599000000',Clinic_Email:'clinic@example.invalid',Address_Text:'جنين',Facility_License_Number:'TEST-1',Description:'وصف تجريبي',Approval_Status:'approved'},hasStaffPermission:()=>true,staffPermissions:'appointments.view',staffClinicRole:'موظف', filters:{q:'',type:'',date:'',page:1},stats:{today:1,sensitive:1,clinical:0,security:0,doctors:0,services:0,appointments:0},records:item.view==='admin/system-log'?[{Log_ID:2,Occurred_Label:'2026-10-25 17:53',Action_Type:'doctor.license.approved',category:'approval',Target_Type:'Doctor',Target_Reference:'1',Description:'اعتماد رقم الترخيص الطبي',Reason:'تم التحقق من البيانات',User_ID:'4',First_Name:'Super',Last_Name:'Admin',Email:'admin@example.invalid'}]:[],total:1,page:1,pages:1,auditTypeLabel:()=>'',auditTypeIcon:()=>'', doctors:[],eligibleDoctors:[],otherMemberships:[],doctorMembershipMessage:'',clinicInvitations:[],clinicInvitationMessage:'',hours:[],exceptions:[],catalog:[],offers:[],saveMessage:'',documents:[], clinic:{Clinic_ID:'1',Clinic_Name:'عيادة اختبار',City:'جنين',Area:'وسط المدينة',Clinic_Phone:'0590000000',Clinic_Email:'clinic@example.invalid',Address_Text:'جنين',Description:'',Latitude:32.45,Longitude:35.29,Online_Booking_Enabled:true,Approval_Status:'approved',Submitted_At:new Date()}, doctor:{Doctor_ID:1,First_Name:'اختبار',Last_Name:'طبيب',Email:'test@example.invalid',License_Number:'TEST-123',License_Status:'pending',Account_Status:'pending',specialties:'طب أسنان عام',License_Review_Notes:null}, result:null,formError:'',error:'',valid:false,resetToken:'',completed:false
  });
  assert(content.includes('<html'), `HTML root missing: ${page}`);
  assert(content.includes('</html>'), `HTML closing missing: ${page}`);
  assert(!content.includes('<%- include('),`Unresolved include: ${page}`);
  checkLocalAssets(content,page.replace(/\.html$/, ''));
  checkPageLinks(content,page);
  assert(!/\.html(?=$|[?#\s"'`<>])/m.test(content), `Stale page link: ${page}`);
  count++;
}
assert.equal(count,110,`Expected 110 UI pages, got ${count}`);
console.log(`PASS: ${count} EJS UI templates render with clean URL asset paths; referenced static assets exist.`);
console.log('NOTE: This is a static preview test, not a backend/database/browser security test.');

for (const role of ['account','admin','auth','clinic','doctor','onboarding','patient','public','staff']) {
  const jsPath=path.join(project,'public',role,'assets','app.js');
  const code=fs.readFileSync(jsPath,'utf8');
  assert(!/\.html(?=$|[?#\s"'`<>])/m.test(code), `Stale URL in ${role}/assets/app.js`);
}
console.log('PASS: No old .html navigation URLs in EJS templates or application JS.');
console.log(`PASS: ${pageLinksChecked} internal anchor links resolve to allowlisted clean page routes.`);
// MFA setup is embedded in the original profile/settings pages instead of
// a second view. The login challenge keeps its own distinct /auth/mfa page.
const loginMfa=render(path.join(viewRoot,'auth/mfa.ejs'),{csrfToken:'test',mfaError:''});
assert(loginMfa.includes('</html>'));
const doctorProfile=render(path.join(viewRoot,'doctor/profile.ejs'),{
 currentUser:{fullName:'د. اختبار'},activeClinic:null,doctorAccount:{First_Name:'اختبار',Last_Name:'طبيب',Email:'doctor@example.invalid',Phone:'0590000000',License_Number:'TEST-1',License_Status:'verified',specialties:[{Name_AR:'طب عام'}]},
 mfaView:{enabled:false,secret:null,uri:null,csrfToken:'test',message:'',error:'',codes:null},
 accountSessions:[],clinicInvitations:[],clinicInvitationMessage:'',sessionActionCsrf:'test-token',sessionActionMessage:'',logoutCsrf:'csrf-test',passwordChangeCsrf:'token',passwordChangeError:'',
 role:'doctor',navVariant:1,drawerVariant:1,footerVariant:1,navActiveClass:()=>'',navAriaCurrent:()=>'',drawerActiveClass:()=>'',drawerAriaCurrent:()=>''
});
assert(doctorProfile.includes('doctor@example.invalid'));
assert(doctorProfile.includes('id="sdc-mfa"'));
checkLocalAssets(doctorProfile,'doctor/profile');
checkPageLinks(doctorProfile,'doctor/profile');
assert(!fs.existsSync(path.join(viewRoot,'account/doctor-profile.ejs')));
assert(!fs.existsSync(path.join(viewRoot,'auth/security.ejs')));
console.log('PASS: MFA and independent doctor profile render in the existing canonical pages.');

for(const [name,locals] of [
 ['auth/password/forgot',{csrfToken:'token',error:''}],
 ['auth/password/reset',{csrfToken:'token',error:'',valid:true,resetToken:'a'.repeat(64)}],
 ['auth/password/reset',{csrfToken:'token',error:'expired',valid:false,resetToken:''}],
 ['auth/password/reset-link-sent',{completed:false}],
 ['auth/password/reset-link-sent',{completed:true}],

]){
 const rendered=render(path.join(viewRoot,name+'.ejs'),locals);
 assert(rendered.includes('</html>'));checkLocalAssets(rendered,name);
 assert(!rendered.includes('data-ui-unbound'));
}
console.log('PASS: Password recovery templates render without demo interception; password change remains in existing profiles.');
