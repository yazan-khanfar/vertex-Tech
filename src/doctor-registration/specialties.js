'use strict';
// Stable public choices in the existing doctor's registration form.
// SPECIALTY has no immutable slug/code column: these exact English names are the
// deterministic mapping and must be kept consistent with the seed script.
const SPECIALTIES = Object.freeze({
  general_dentistry: { ar: 'طب أسنان عام', en: 'General Dentistry' },
  endodontics: { ar: 'علاج جذور', en: 'Endodontics' },
  orthodontics: { ar: 'تقويم الأسنان', en: 'Orthodontics' },
  oral_surgery: { ar: 'جراحة الفم', en: 'Oral Surgery' },
  prosthodontics: { ar: 'التركيبات السنية', en: 'Prosthodontics' },
  pediatric_dentistry: { ar: 'أسنان أطفال', en: 'Pediatric Dentistry' }
});
module.exports = { SPECIALTIES };
