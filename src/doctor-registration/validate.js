'use strict';
const { SPECIALTIES } = require('./specialties');
const asText = (value, max) => typeof value === 'string' && value.length <= 2 * max ? value.trim() : '';
function parseDoctorForm(body) {
  if (!body || typeof body !== 'object') return { error: 'البيانات المرسلة غير صالحة.' };
  const firstName = asText(body.first_name,150);
  const lastName = asText(body.last_name,150);
  const email = asText(body.email,254).toLowerCase();
  const phone = asText(body.phone,30);
  const license = asText(body.license_number,150);
  const password = body.password;
  const confirm = body.confirm_password;
  const specialties = body['specialty_ids[]'];
  const selected = Array.isArray(specialties) ? specialties : (typeof specialties === 'string' ? [specialties] : []);
  if (!firstName || firstName.length>150 || !lastName || lastName.length>150) return {error:'يرجى إدخال الاسم الأول واسم العائلة بشكل صحيح.'};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254) return {error:'يرجى إدخال بريد إلكتروني صالح.'};
  const digits = phone.replace(/\D/g,'');
  if (phone.length>30 || !/^[+0-9 ()\-]+$/.test(phone) || digits.length<7 || digits.length>15) return {error:'يرجى إدخال رقم هاتف صالح.'};
  // Identifier, not uploaded document. Avoid control characters and allow common separators.
  if (typeof body.license_number !== 'string' || /[\r\n\t]/.test(body.license_number) || !license || license.length>150 || !/^[\p{L}\p{N}][\p{L}\p{N} _./-]*$/u.test(license)) return {error:'يرجى إدخال رقم ترخيص طبي صحيح.'};
  if (!selected.length || selected.length>6 || new Set(selected).size !== selected.length || selected.some(s => typeof s !== 'string' || (!Object.hasOwn(SPECIALTIES,s)&&!/^[1-9]\d{0,17}$/.test(s)))) return {error:'يرجى اختيار تخصص واحد صحيح على الأقل.'};
  if (typeof password !== 'string' || password.length<8 || password.length>128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) return {error:'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل وحرف كبير وصغير ورقم.'};
  if (password!==confirm) return {error:'تأكيد كلمة المرور غير مطابق.'};
  if (body.accept_policies!=='on') return {error:'يرجى الموافقة على الشروط وسياسة الخصوصية.'};
  return {data:{firstName,lastName,email,phone,license,password,specialties:selected}};
}
module.exports={parseDoctorForm};
