'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const pageMap = require('../config/page-map.json');
const roles = ['home', 'patient', 'clinic', 'doctor', 'admin', 'staff'];
let covered = 0;
for (const role of roles) {
  const dir = path.join(base, 'views', 'partials', role);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['footer.ejs', 'header.ejs'], `Expected only header/footer in ${role}`);
  const header = fs.readFileSync(path.join(dir, 'header.ejs'), 'utf8');
  const footer = fs.readFileSync(path.join(dir, 'footer.ejs'), 'utf8');
  assert(!/include\(['\"](?:nav|drawer|footer)-\d+/.test(header + footer), `Legacy partial in ${role}`);
  for (const [legacyKey, page] of Object.entries(pageMap)) {
    if (page.role !== role) continue;
    const html = fs.readFileSync(path.join(base, 'views', page.view + '.ejs'), 'utf8');
    assert.equal(html.split(`partials/${role}/header`).length - 1, 1, `Header missing/duplicated: ${legacyKey}`);
    assert.equal(html.split(`partials/${role}/footer`).length - 1, 1, `Footer missing/duplicated: ${legacyKey}`);
    covered++;
  }
}
assert.equal(covered, 90, 'Expected 90 role pages to include shared header and footer');
console.log(`PASS: ${covered} role pages reference exactly one header and footer. Six role layout directories contain only two EJS files each.`);
console.log('NOTE: Footer partials for admin and staff intentionally render no visual footer.');
