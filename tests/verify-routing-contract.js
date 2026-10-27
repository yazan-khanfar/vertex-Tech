'use strict';
// Dependency-free routing contract test. Tests real application route handlers
// against a mocked Express API; not an HTTP integration or browser test.
const assert = require('node:assert/strict');
const Module = require('node:module');
const pages = require('../config/page-map.json');
const routes = [];
const posts = [];
const uses = [];
const app = {
  disable() {},
  set() {},
  use(...args) { uses.push(args); },
  get(selector, handler) { routes.push({selector, handler}); },
  post(selector, ...handlers) { posts.push({selector, handlers}); },
  listen() { throw Error('Test must never start a listening server'); },
};
function mockExpress() { return app; }
mockExpress.static = () => { const assets = (_req, _res, next) => next(); assets.isPublicAssets = true; return assets; };
mockExpress.urlencoded = () => (_req, _res, next) => next();
const original = Module._load;
Module._load = function(request, ...args) {
  if (request === './src/workspace/router') return {attach() {}}; // Connected workflows have HTTP/database integration coverage.
  if (request === 'express') return mockExpress;
  if (request === './src/daily-operations/router') return {clinicRouter:(_req,_res,next)=>next(),doctorRouter:(_req,_res,next)=>next()};
  if (request === './src/registration/router' || request === './src/doctor-registration/router' || request === './src/admin-review/router' || request === './src/auth/router' || request === './src/auth/context-router' || request === './src/mfa/router' || request === './src/password-reset/router' || request === './src/password-reset/change-router' || request === './src/auth/sessions-router' || request === './src/clinic-onboarding/router' || request === './src/clinic-dashboard/router' || request === './src/clinic-settings-router' || request === './src/clinic-patients/router' || request === './src/clinic-staff/router' || request === './src/clinic-clinical-router' || request === './src/clinic-finance-inventory-router' || request === './src/clinic-notifications-router' || request === './src/clinic-documents-router' || request === './src/clinic-remaining-router' || request === './src/clinic-account-settings/router' || request === './src/appointments/router' || request === './src/doctor-workspace/router' || request === './src/doctor-workspace/clinical-router') return (_req,_res,next)=>next();
  if (request === './src/auth/guard') return {guard:()=> (_req,_res,next)=>next()};
  return original.call(this, request, ...args);
};
try {
  assert.equal(require('../server'), app);
} finally {
  Module._load = original;
}
assert(uses.some(args => args[0] === '/auth/register/patient'), 'Patient registration router must be mounted');
assert(uses.some(args => args[0] === '/auth/register/doctor'), 'Doctor registration router must be mounted');
assert(uses.some(args => args[0] === '/admin'), 'Admin review router must be mounted');
const publicAssetIndex = uses.findIndex(args => args[0]?.isPublicAssets);
assert(publicAssetIndex >= 0, 'Public assets must be mounted');
for (const role of ['/patient','doctor','clinic','staff']) {
  const guardAt = uses.findIndex(args => args[0] === role || args[0] === '/' + role);
  assert(guardAt >= 0, `Role guard must exist: ${role}`);
  assert(publicAssetIndex < guardAt, `Public assets must load before ${role} clinic-context guard`);
}

assert(uses.some(args=>args[0]==='/auth'),'Unified authentication router must be mounted');
assert(uses.some(args=>args[0]==='/patient'),'Patient appointments routes must be mounted');
assert(uses.some(args=>args[0]==='/clinic'),'Clinic appointments routes must be mounted');
assert(uses.some(args=>args[0]==='/doctor'),'Doctor appointments routes must be mounted');
assert(uses.some(args=>args[0]==='/doctor' && args[1] && typeof args[1]==='function'),'Doctor workspace must be mounted');
assert(uses.some(args=>args[0]==='/auth/security'),'MFA enrollment router must be mounted');
assert(uses.some(args=>args[0]==='/auth/password'),'Password recovery router must be mounted');
assert(uses.some(args=>args[0]==='/auth/change-password'),'Password change router must be mounted');
assert(routes.some(r=>r.selector==='/doctor/profile'),'Existing doctor profile route must be available without a clinic');
assert(posts.some(r=>r.selector==='/doctor/profile/membership'),'Doctor invitation actions must work without a clinic');
assert(routes.some(r=>r.selector==='/account/doctor-profile'),'Old extra profile URL must redirect');
assert(uses.some(args=>args[0]==='/account/sessions'),'Session actions must be mounted on existing profiles');
assert.equal(routes.length, 4, 'Expected two canonical doctor handlers plus legacy/clean route handlers');
const redirect = routes[2];
const render = routes[3];
assert(redirect.selector.test('/patient/appointments.html'));
assert(!redirect.selector.test('/patient/appointments'));
assert(render.selector.some(s => s === '/'));
assert(render.selector.some(s => s instanceof RegExp && s.test('/patient/appointments')));
let count = 0;
for (const [legacyKey, item] of Object.entries(pages)) {
  const old = '/' + legacyKey;
  const clean = '/' + legacyKey.slice(0, -5);
  let redirected;
  redirect.handler({path: old, originalUrl: old + '?id=123&mode=1'}, {
    redirect(code, location) { redirected = {code, location}; },
  }, () => { throw Error('Known legacy URL must redirect'); });
  assert.deepEqual(redirected, {code: 301, location: clean + '?id=123&mode=1'});
  let rendered;
  render.handler({path: clean}, {
    setHeader() {},
    render(view, locals, cb) {
      rendered = {view, locals};
      cb(null, '<html>OK</html>');
    },
    type(type) { assert.equal(type,'html'); return this; },
    send(html) { assert.equal(html,'<html>OK</html>'); },
  }, error => { if(error) throw error; throw Error('Known URL must render'); });
  assert.equal(rendered.view, item.view);
  assert.equal(rendered.locals.currentPage, legacyKey);
  assert.equal(rendered.locals.role, item.role);
  count++;
}
let homeRendered = false;
render.handler({path: '/'}, {
  render(view, locals, cb) { assert.equal(view, pages['index.html'].view); homeRendered = true; cb(null,'ok'); },
  type() { return this; }, send() {},
}, () => { throw Error('Expected homepage to render'); });
assert(homeRendered);
let unknownNext = 0;
redirect.handler({path:'/unknown.html',originalUrl:'/unknown.html'}, {redirect(){throw Error('Unknown redirect');}},()=>unknownNext++);
render.handler({path:'/unknown'}, {render(){throw Error('Unknown render');}},()=>unknownNext++);
assert.equal(unknownNext,2);
console.log(`PASS: ${count} legacy redirects (301+query), ${count} clean page routes, home alias, and unknown-route rejections.`);
console.log('NOTE: Tested handlers without installed Express; real HTTP/browser integration must run where npm dependencies are available.');
