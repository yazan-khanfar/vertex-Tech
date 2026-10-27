'use strict';
// Canonical stored values are English; accept legacy Arabic values when reading.
// Unknown or empty input must never be labeled as female by default.
function normalizeGender(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'male' || text === 'ذكر') return 'male';
  if (text === 'female' || text === 'أنثى' || text === 'انثى') return 'female';
  return null;
}
function genderLabel(value) {
  const normalized = normalizeGender(value);
  return normalized === 'male' ? 'ذكر' : normalized === 'female' ? 'أنثى' : 'غير محدد';
}
module.exports = { normalizeGender, genderLabel };
