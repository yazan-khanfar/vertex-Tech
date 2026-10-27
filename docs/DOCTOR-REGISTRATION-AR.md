# تنفيذ وتحقق تسجيل الطبيب — المرحلة الثانية

## ماذا أصبح يعمل؟
- `GET /auth/register/doctor` يعرض نموذج الطبيب مع رمز CSRF موقّع.
- `POST /auth/register/doctor` يتحقق من الاسم، الهاتف، البريد، رقم الترخيص، التخصصات، كلمة المرور والموافقة؛ يحد المحاولات ويمنع حفظ البيانات الجزئي.
- يحفظ `sdc."USER"` مع `Account_Status='pending'` و`Login_Enabled=false`، ويحفظ `sdc."DOCTOR"` مع `License_Status='pending'` (مطلوب بواسطة قيود قاعدة البيانات).
- يحفظ روابط `sdc."HAS_SPECIALTY"` للتخصصات المختارة، بعد مطابقتها بتخصصات فعالة في `sdc."SPECIALTY"`، ويسجل الموافقتين في `sdc."USER_POLICY_CONSENTS"`.
- يرفض التكرار بسبب فهارس البريد ورقم الترخيص؛ جميع الإضافات في معاملة واحدة تنجح كلها أو تُلغى كلها.
- لا يغير تسجيل المريض الذي سبق نجاحه.

## إعداد قاعدة البيانات (بدون إعادة إنشاء قاعدة البيانات)
من مجلد المشروع الذي يحتوي `package.json`:

```powershell
npm install
npm run db:seed:doctor
npm test
npm start
```

ينشئ `db:seed:doctor` الدور System Doctor (إن لم يكن موجودًا)، ويضيف ستة تخصصات احترافية باللغة العربية والإنجليزية **إذا لم تكن موجودة بنفس الاسم الإنجليزي**، دون حذف البيانات أو استبدالها. إذا كانت هناك أسماء تخصصات متكررة أو غير مفعلة، يتوقف ويطلب إصلاحها بدل الإلحاق الخاطئ.

**لا تعِد تشغيل ملف إنشاء السكيما على قاعدة فيها بيانات.** `db:seed:patient` لا يلزم تكراره إن سبق تشغيله.

## الاختبار على جهازك
1. افتح `http://localhost:3000/auth/register/doctor` وأدخل اسمًا وهاتفًا وبريدًا **جديدًا** ورقم ترخيص **جديدًا**، واختر تخصصًا أو أكثر ووافق على الشروط.
2. بعد نجاح الطلب ستحوّل إلى `/onboarding/doctor/verification-pending?registration=created`؛ هذه **صفحة انتظار تمهيدية فقط وليست اعتمادًا حقيقيًا**.
3. نفذ هذه الاستعلامات داخل pgAdmin (لا حاجة لإرسال كلمات مرور):

```sql
SELECT u."User_ID", u."First_Name", u."Last_Name", u."Email", u."Phone",
       u."Account_Status", u."Login_Enabled", r."Role_Name",
       d."Doctor_ID", d."License_Number", d."License_Status",
       d."License_Reviewed_By_User_ID"
FROM sdc."USER" u
JOIN sdc."ROLE" r ON r."Role_ID"=u."Role_ID"
JOIN sdc."DOCTOR" d ON d."User_ID"=u."User_ID"
ORDER BY d."Doctor_ID" DESC;

SELECT d."Doctor_ID", s."Name_AR", s."Name_EN"
FROM sdc."DOCTOR" d
JOIN sdc."HAS_SPECIALTY" h ON h."Doctor_ID"=d."Doctor_ID"
JOIN sdc."SPECIALTY" s ON s."Specialty_ID"=h."Specialty_ID"
ORDER BY d."Doctor_ID" DESC, s."Name_EN";

SELECT u."Email", c."Policy_Type", c."Policy_Version"
FROM sdc."USER" u JOIN sdc."USER_POLICY_CONSENTS" c ON c."User_ID"=u."User_ID"
WHERE u."Email"='REPLACE_WITH_TEST_DOCTOR_EMAIL';
```

4. اختبر تسجيلًا ثانيًا بنفس البريد أو رقم الترخيص. يجب أن تظهر رسالة منع التكرار، دون إنشاء أي طبيب إضافي.
5. اختبر تخصصًا فارغًا، رقم هاتف غير صحيح، كلمتي مرور مختلفتين، وعدم الموافقة.
6. إذا أردت حساب العدد لنفس الترخيص: `SELECT COUNT(*) FROM sdc."DOCTOR" WHERE lower(btrim("License_Number"))=lower(btrim('MED-88421'));` مع استبدال الرقم بقيمتك.

## ما لم يكتمل بعد
- لا توجد جلسات مصادقة ولا تسجيل دخول حقيقي ولا شاشة فعلية محمية لمراجعة/اعتماد ترخيص الطبيب بعد.
- لا تفعّل حساب الطبيب يدويًا قبل بناء/اختبار موافقة المشرف الآمنة، ولا تدخل إلى واجهة الطبيب على أساس أن الصفحات التجريبية تحمي الوصول: **معظم صفحات العرض غير محمية حتى الآن**.
- اختيار التخصصات مسجل، لكنه لا يثبت أهلية الطبيب للعمل؛ اعتماد رقم الترخيص ومراجعة التخصصات من طرف المشرف/النظام لاحقًا.
- ملف SQL في `db/schema/` هو النسخة الأصلية ذات الـ57 جدولًا كما رفعتها. لم نعدّله.
- اختبار PostgreSQL الحقيقي لم يتم من بيئة المساعد؛ يتم معك محليًا عبر الخطوات أعلاه.
