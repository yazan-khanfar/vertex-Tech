'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function source(name) { return fs.readFileSync(path.join(root, name), 'utf8'); }
const targets = [
 ['patient/profile','patient'],
 ['clinic/account-settings','clinic'],
 ['admin/settings','admin']
];
for (const [view, scope] of targets) {
 test(`${view} keeps its existing password editor and posts to the backend`, () => {
  const s = source(`views/${view}.ejs`);
  const matches = [...s.matchAll(/<form\b[^>]*id="sdc-change-password-form"[^>]*>([\s\S]*?)<\/form>/g)];
  assert.equal(matches.length, 1);
  assert.match(matches[0][0], /action="\/auth\/change-password"/);
  assert.match(matches[0][0], /method="post"/);
  assert.match(matches[0][1], /name="csrf_token"/);
  assert(matches[0][1].includes(`value="${scope}"`));
  for (const name of ['current_password','new_password','confirm_password']) {
   assert(s.includes(`name="${name}"`));
  }
  assert(s.includes('id="sdc-password"'), 'password form has in-page anchor');
  assert(!s.includes('href="/auth/change-password"'), 'no standalone password page link');
 });
}
for (const [view, scope] of [['doctor/profile','doctor'],['staff/profile','staff']]) {
 test(`${view} has one inline password editor, not a second page`, () => {
  const s=source(`views/${view}.ejs`);
  assert(s.includes(`passwordScope: '${scope}'`));
  assert(!s.includes('href="/auth/change-password"'));
 });
}
test('doctor settings no longer hosts a duplicate change password form',()=>{
 const s=source('views/doctor/settings.ejs');
 assert(!s.includes('sdc-change-password-form'));
 assert(s.includes('profile#sdc-password'));
});
test('no separate password change page; old GET redirects and POST retains secure service',()=>{
 assert(!fs.existsSync(path.join(root,'views/auth/change-password.ejs')));
 const change=source('src/password-reset/change-router.js');
 assert(change.includes("router.get('/', (req, res) => returnToProfile(req, res, ''))"));
 assert(change.includes('validateSessionCsrf(req)'));
 assert(change.includes('changePassword(getPool(), req.sdcActor.userId'));
 assert(change.includes("res.redirect(303, '/auth/login?password_changed=1')"));
 assert(!change.includes("render('auth/change-password'"));
 const service=source('src/password-reset/service.js');
 assert(service.includes('revokeUserSessions(userId)'));
 assert(service.includes('account.password.changed'));
});
test('profile redirects are fixed allowlisted paths, not user-provided URLs',()=>{
 const {profilePath,passwordError}=require('../src/password-reset/profile-destinations');
 const actor=r=>({role:r});
 assert.equal(profilePath(actor('patient'),'someurl'),'/patient/profile');
 assert.equal(profilePath(actor('admin'),'someurl'),'/admin/settings');
 assert.equal(profilePath(actor('staff'),'someurl'),'/staff/profile');
 assert.equal(profilePath(actor('doctor'),'independent',{clinicId:null},[]),'/doctor/profile');
 assert.equal(profilePath(actor('doctor'),'doctor',{clinicId:'7'},[{id:'7',manager:false}]),'/doctor/profile');
 assert.equal(profilePath(actor('doctor'),'clinic',{clinicId:'7'},[{id:'7',manager:true}]),'/clinic/account-settings');
 assert.equal(profilePath(actor('doctor'),'clinic',{clinicId:'7'},[{id:'7',manager:false}]),'/doctor/profile');
 assert(passwordError('current'));
 assert.equal(passwordError('arbitrary-code'),'');
});
test('MFA security screen routes to profile instead of a password page',()=>{
 const s=source('views/partials/shared/mfa-manager.ejs');
 assert(s.includes('id="sdc-mfa"'));
 assert(!s.includes('href="/auth/change-password"'));
 assert(!fs.existsSync(path.join(root,'views/auth/security.ejs')));
});
