'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {put,take}=require('../src/mfa/one-time-feedback');
const {profilePath}=require('../src/password-reset/profile-destinations');
const root=path.resolve(__dirname,'..');
const code=file=>fs.readFileSync(path.join(root,file),'utf8');
function request(hex='a'){return {sdcSession:{tokenHash:hex.repeat(64)}};}
test('MFA messages and one-time recovery codes survive only one canonical profile redirect',()=>{
  const req=request('a');
  const codes=['ALPHA','BRAVO'];
  put(req,{message:'تم التفعيل',codes});
  codes[0]='MUTATED';
  const view=take(req);
  assert.equal(view.message,'تم التفعيل');
  assert.deepEqual(view.codes,['ALPHA','BRAVO']);
  assert.equal(take(req),null);
});
test('MFA feedback is isolated by session, rejects untracked access, and is never stored in URL or HTML',()=>{
  const a=request('b'),b=request('c');
  put(a,{error:'كلمة المرور غير صحيحة.'});
  assert.equal(take(b),null);
  assert.equal(take(a).error,'كلمة المرور غير صحيحة.');
  assert.throws(()=>put({},{}),/tracked session/);
  const router=code('src/mfa/router.js');
  assert.match(router,/res\.redirect\(303,dest\+'#sdc-mfa'\)/);
  assert(!router.includes('renderProfile('),'Never render original profile at POST URL');
  for(const action of ['/start','/confirm','/cancel','/disable'])assert(router.includes(`router.post('${action}'`));
});
test('MFA redirects to each existing role page including clinic manager scope',()=>{
  const session={clinicId:'11'};
  const clinics=[{id:'11',manager:true}];
  assert.equal(profilePath({role:'patient'},'patient',session,clinics),'/patient/profile');
  assert.equal(profilePath({role:'doctor'},'doctor',session,clinics),'/doctor/profile');
  assert.equal(profilePath({role:'doctor'},'clinic',session,clinics),'/clinic/account-settings');
  assert.equal(profilePath({role:'doctor'},'clinic',session,[]),'/doctor/profile');
  assert.equal(profilePath({role:'staff'},'staff',session,clinics),'/staff/profile');
  assert.equal(profilePath({role:'admin'},'admin',session,clinics),'/admin/settings');
});
test('Admin security tab can be restored after a redirect to the original page',()=>{
  const tpl=code('views/admin/settings.ejs');
  const manager=code('views/partials/shared/mfa-manager.ejs');
  assert(tpl.includes('data-bs-target="#security" data-bs-toggle="pill"'));
  assert(manager.includes('bootstrap.Tab.getOrCreateInstance(trigger).show()'));
  assert(manager.includes("window.location.hash !== '#sdc-mfa'"));
});
