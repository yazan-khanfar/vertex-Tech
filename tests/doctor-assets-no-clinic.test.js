'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

test('a doctor without a clinic can load shared and doctor UI assets before role guards',()=>{
  const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
  const mounted=server.indexOf("app.use(express.static(path.join(__dirname, 'public')");
  const doctorGuard=server.indexOf("app.use('/doctor',guard('doctor'))");
  const clinicGuard=server.indexOf("app.use('/clinic',guard('clinic'))");
  assert(mounted!==-1 && mounted<doctorGuard && mounted<clinicGuard);
  for(const asset of ['doctor/assets/styles.css','doctor/assets/app.js',
    'assets/vendor/937abe4f713b-bootstrap.rtl.min.css','assets/vendor/28667e4f82c7-bootstrap-icons.css'])
    assert(fs.existsSync(path.join(root,'public',asset)),`Missing: ${asset}`);
});
