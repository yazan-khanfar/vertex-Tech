'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const policy=require('../src/staff-access/policy');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
// Tiny test-only EJS subset to exercise conditional markup without npm packages.
function render(source,props){
 let expression='let html="";\n';let cursor=0;
 const re=/<%([=-]?)([\s\S]*?)%>/g;let m;
 while((m=re.exec(source))){
  expression+='html+='+JSON.stringify(source.slice(cursor,m.index))+';\n';
  if(m[1])expression+='html+=String(('+m[2]+')??"");\n';
  else expression+=m[2]+'\n';
  cursor=m.index+m[0].length;
 }
 expression+='html+='+JSON.stringify(source.slice(cursor))+';\nreturn html;';
 return new Function('p','with(p){'+expression+'}')(props);
}
function fixture(perms='appointments.view'){
 return {staffPermissions:perms,staffClinicRole:'موظف استقبال',
 currentUser:{fullName:'موظف اختبار',userId:'56'},activeClinic:{id:'41',name:'عيادة اختبار'},
 navVariant:1,drawerVariant:1,navActiveClass:()=>'',navAriaCurrent:()=>'',drawerActiveClass:()=>'',drawerAriaCurrent:()=>'',
 hasStaffPermission:code=>policy.can(perms,code), include:()=>''};
}
test('routes are denied by default and each protected path has an explicit permission',()=>{
 for(const [url,permission] of Object.entries(policy.VIEW_PERMISSIONS))assert.deepEqual(policy.accessFor('GET',url),{permission});
 assert.deepEqual(policy.accessFor('POST','/operations/action'),{permission:'appointments.manage'});
 for(const m of ['POST','PUT','DELETE'])assert.deepEqual(policy.accessFor(m,'/patients'),{deny:true});
 for(const p of ['/unknown','/invoices/export','/lab-cases/delete','/patients/44'])assert.deepEqual(policy.accessFor('GET',p),{deny:true});
 for(const p of ['/index','/profile','/choose-clinic'])assert.deepEqual(policy.accessFor('GET',p),{publicWithinStaff:true});
});
test('desktop and drawer menus are server-rendered with only permitted modules',()=>{
 const h=read('views/partials/staff/header.ejs');
 const one=render(h,fixture('appointments.view'));
 assert.equal((one.match(/href="appointments"/g)||[]).length,2);
 for(const name of ['patients','invoices','lab-cases'])assert(!one.includes('href="'+name+'"'));
 const none=render(h,fixture(''));
 for(const name of ['appointments','patients','invoices','lab-cases'])assert(!none.includes('href="'+name+'"'));
 const all=render(h,fixture('appointments.view patients.view_admin invoices.view lab_orders.view'));
 for(const name of ['appointments','patients','invoices','lab-cases'])assert(all.includes('href="'+name+'"'));
});
test('dashboard retains original cards but never embeds forbidden links or fixed demo clinic',()=>{
 const original=read('views/staff/index.ejs');
 const page=render(original,fixture('appointments.view'));
 assert(page.includes('href="appointments"'));
 assert(!page.includes('href="patients"'));
 assert(!page.includes('href="invoices"'));
 assert(page.includes('عيادة اختبار'));
 assert(!page.includes('عيادة الابتسامة الحديثة'));
 assert(!page.includes('أهلاً نور'));
 assert(!page.includes('3 بانتظار الموافقة'));
 const all=render(original,fixture('appointments.view patients.view_admin invoices.view'));
 assert(all.includes('href="patients"')&&all.includes('href="invoices"'));
});
test('route guard uses allowlist, scoped membership, and denies missing grants',()=>{
 const guard=read('src/auth/guard.js');
 assert(guard.includes('accessFor(req.method'));
 assert(guard.includes('"Membership_Status"=\'active\''));
 assert(guard.includes('rule.permission&&!can('));
 assert(guard.includes('return res.status(403)'));
 assert(guard.includes('/staff/choose-clinic'));
});
