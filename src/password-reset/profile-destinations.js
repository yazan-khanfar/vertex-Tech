'use strict';
const ERROR_MESSAGES = Object.freeze({
  csrf: 'انتهت صلاحية الطلب. حدّث الصفحة ثم حاول من جديد.',
  attempts: 'محاولات كثيرة لتغيير كلمة المرور. حاول بعد 15 دقيقة.',
  invalid: 'كلمة المرور الجديدة يجب أن تحتوي على 14 حرفًا على الأقل، أحرف وأرقام ورمز، وأن يطابق التأكيد الكلمة الجديدة.',
  current: 'كلمة المرور الحالية غير صحيحة أو كلمة المرور الجديدة مطابقة للقديمة.',
  unavailable: 'تعذّر تغيير كلمة المرور حاليًا. حاول لاحقًا.'
});

function passwordError(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : '';
}
// The route is used only for handling form submissions. No separate password page exists.
function profilePath(actor, requestedScope, session, clinics) {
  switch (actor.role) {
    case 'patient': return '/patient/profile';
    case 'staff': return '/staff/profile';
    case 'admin': return '/admin/settings';
    case 'doctor': {
      const chosen = clinics?.find(c => c.id === session?.clinicId);
      if (requestedScope === 'clinic' && chosen?.manager) return '/clinic/account-settings';
      if (requestedScope === 'independent') return '/doctor/profile';
      return '/doctor/profile';
    }
    default: return '/auth/login';
  }
}
module.exports = { passwordError, profilePath };
