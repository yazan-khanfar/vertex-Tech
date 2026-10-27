"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { field: F, form: form, table: T } = C;
const options = (values) => values.map(([value, label]) => ({ value, label }));
const col = (key, label, href) => ({ key, label, href });
async function profile(user) {
  const r = await getPool().query(
    `SELECT p.*,u."First_Name",u."Last_Name",u."Email",u."Phone",u."Preferred_Language",to_char(p."Date_Of_Birth",'YYYY-MM-DD') dob FROM sdc."PATIENT" p JOIN sdc."USER" u USING("User_ID") WHERE u."User_ID"=$1`,
    [user],
  );
  if (!r.rowCount) throw C.error("ملف المريض غير موجود.", 404);
  return r.rows[0];
}
async function saveHealth(user, b) {
  const lines = (v) => {
    const values = [
      ...new Set(
        C.text(v ?? "", 8000, false)
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (values.length > 50 || values.some((x) => x.length > 150))
      throw C.error(
        "اكتب كل معلومة صحية بسطر مستقل، بحد أقصى 150 حرفًا للسطر و50 سطرًا.",
      );
    return values;
  };
  const all = lines(b.allergies),
    chronic = lines(b.chronic),
    meds = lines(b.medications);
  const blood = C.text(b.blood, 10);
  if (
    !["unknown", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].includes(
      blood,
    )
  )
    throw C.error("فصيلة دم غير صالحة.");
  const notes = C.text(b.health_notes ?? "", 10000, false);
  const birth = b.date_of_birth === undefined ? null : C.date(b.date_of_birth);
  const gender =
    b.gender === undefined
      ? null
      : require("../patients/gender").normalizeGender(b.gender);
  if (
    (birth &&
      (birth > require("../appointments/service").localNow().date ||
        birth < "1900-01-01")) ||
    (b.gender !== undefined && !gender)
  )
    throw C.error("راجع تاريخ الميلاد والجنس.");
  const version = String(b.profile_version || "");
  if (!/^\d{1,9}$/.test(version))
    throw C.error("حدّث ملفك الصحي قبل الحفظ.", 409);
  return C.tx(user, async (db) => {
    const p = await db.query(
      'UPDATE sdc."PATIENT" SET "Blood_Type"=$2,"Health_Notes"=$3,"Date_Of_Birth"=COALESCE($5::date,"Date_Of_Birth"),"Gender"=COALESCE($6,"Gender"),"Health_Profile_Completed_At"=LOCALTIMESTAMP,"Profile_Version"="Profile_Version"+1 WHERE "User_ID"=$1 AND "Profile_Version"=$4 RETURNING "Patient_ID"',
      [user, blood, notes, version, birth, gender],
    );
    if (!p.rowCount)
      throw C.error(
        "تغير ملفك الصحي من نافذة أخرى. حدّث الصفحة وراجع التغييرات.",
        409,
      );
    const pid = p.rows[0].Patient_ID;
    for (const [table, column, values] of [
      ["PATIENT_ALLERGIES", "Allergies", all],
      ["PATIENT_CHRONIC_DISEASES", "Chronic_Diseases", chronic],
      ["PATIENT_CURRENT_MEDICATIONS", "Current_Medications", meds],
    ]) {
      await db.query(`DELETE FROM sdc."${table}" WHERE "Patient_ID"=$1`, [pid]);
      for (const value of values)
        await db.query(
          `INSERT INTO sdc."${table}"("Patient_ID","${column}") VALUES($1,$2)`,
          [pid, value],
        );
    }
    await C.audit(
      db,
      user,
      "patient.health.updated",
      "Patient",
      pid,
      "تحديث المريض لمعلوماته الصحية",
    );
    return { healthProfileCompleted: true };
  });
}
async function accountSave(user, b) {
  const first = C.text(b.first_name),
    last = C.text(b.last_name),
    phone = C.text(b.phone, 30),
    email = C.text(b.email, 254).toLowerCase(),
    language = C.text(b.language || "ar", 10);
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !/^[+\d ()-]{7,30}$/.test(phone) ||
    !["ar", "en"].includes(language)
  )
    throw C.error("راجع البريد والهاتف واللغة.");
  await C.tx(user, async (db) => {
    const current = await db.query(
      'SELECT "Email","Phone","Password_Hash" FROM sdc."USER" WHERE "User_ID"=$1 FOR UPDATE',
      [user],
    );
    const u = current.rows[0];
    if (email !== u.Email || phone !== u.Phone) {
      if (
        !(await require("../security/password").verifyPassword(
          String(b.current_password || ""),
          u.Password_Hash,
        ))
      )
        throw C.error("أدخل كلمة المرور الحالية لتغيير البريد أو الهاتف.", 403);
    }
    await db.query(
      'UPDATE sdc."USER" SET "First_Name"=$2,"Last_Name"=$3,"Email"=$4,"Phone"=$5,"Preferred_Language"=$6 WHERE "User_ID"=$1',
      [user, first, last, email, phone, language],
    );
    await C.audit(
      db,
      user,
      "account.profile.updated",
      "User",
      user,
      "تحديث بيانات الحساب",
    );
  });
}
async function accountSection(user, action) {
  const r = await getPool().query(
    'SELECT "First_Name","Last_Name","Email","Phone","Preferred_Language" FROM sdc."USER" WHERE "User_ID"=$1',
    [user],
  );
  const p = r.rows[0];
  return form("بيانات الحساب", action, [
    F("first_name", "الاسم الأول", p.First_Name),
    F("last_name", "اسم العائلة", p.Last_Name),
    F("email", "البريد الإلكتروني", p.Email, "email"),
    F("phone", "الهاتف", p.Phone, "tel"),
    F(
      "language",
      "اللغة",
      p.Preferred_Language,
      "select",
      options([
        ["ar", "العربية"],
        ["en", "English"],
      ]),
    ),
    {
      ...F(
        "current_password",
        "كلمة المرور الحالية عند تغيير البريد أو الهاتف",
        "",
        "password",
      ),
      required: false,
    },
  ]);
}
function attach(router) {
  router.get(
    "/patient/profile",
    C.route(async (req, res) => {
      const a = C.actor(req, ["patient"]),
        p = await profile(a.userId);
      const arrays = await Promise.all(
        [
          ["PATIENT_ALLERGIES", "Allergies"],
          ["PATIENT_CHRONIC_DISEASES", "Chronic_Diseases"],
          ["PATIENT_CURRENT_MEDICATIONS", "Current_Medications"],
        ].map(async ([t, c]) =>
          (
            await getPool().query(
              `SELECT "${c}" value FROM sdc."${t}" WHERE "Patient_ID"=$1 ORDER BY "${c}"`,
              [p.Patient_ID],
            )
          ).rows
            .map((r) => r.value)
            .join("\n"),
        ),
      );
      C.page(
        req,
        res,
        "patient/profile",
        "حسابي ومعلوماتي الصحية",
        [
          await accountSection(a.userId, "/patient/account/save"),
          form(
            "المعلومات الصحية",
            "/patient/health-profile",
            [
              F("date_of_birth", "تاريخ الميلاد", p.dob, "date"),
              F(
                "gender",
                "الجنس",
                p.Gender,
                "select",
                options([
                  ["male", "ذكر"],
                  ["female", "أنثى"],
                ]),
              ),
              F(
                "blood",
                "فصيلة الدم",
                p.Blood_Type,
                "select",
                options(
                  [
                    "unknown",
                    "A+",
                    "A-",
                    "B+",
                    "B-",
                    "AB+",
                    "AB-",
                    "O+",
                    "O-",
                  ].map((x) => [x, x === "unknown" ? "غير معروفة" : x]),
                ),
              ),
              ...["allergies", "chronic", "medications"].map((name, i) => ({
                ...F(
                  name,
                  [
                    "الحساسية: معلومة في كل سطر",
                    "الأمراض المزمنة: معلومة في كل سطر",
                    "الأدوية الحالية: دواء في كل سطر",
                  ][i],
                  arrays[i],
                  "textarea",
                ),
                required: false,
              })),
              {
                ...F(
                  "health_notes",
                  "الملاحظات الصحية",
                  p.Health_Notes,
                  "textarea",
                ),
                required: false,
              },
            ],
            { profile_version: p.Profile_Version },
          ),
        ],
        await require("./accounts").securityData(req),
      );
    }),
  );
  router.post(
    "/patient/account/save",
    express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 }),
    C.post(async (req, res) => {
      await accountSave(C.actor(req, ["patient"]).userId, req.body);
      res.redirect(303, "/patient/profile?saved=1");
    }),
  );
  router.post(
    "/patient/health-profile",
    express.urlencoded({ extended: false, limit: "48kb", parameterLimit: 12 }),
    C.post(async (req, res) => {
      const result = await saveHealth(
        C.actor(req, ["patient"]).userId,
        req.body,
      );
      if (req.accepts(["html", "json"]) === "json") return res.json(result);
      res.redirect(303, "/patient/profile?saved=1");
    }),
  );
  router.get(
    "/patient/index",
    C.route(async (req, res) => {
      const p = await profile(C.actor(req, ["patient"]).userId);
      const [bookings, bills] = await Promise.all([
        getPool().query(
          `SELECT b."Booking_ID"::text id,b."Appointment_Date"::text date,b."Start_Time"::text time,b."Booking_Status" status,c."Clinic_Name" clinic FROM sdc."BOOKING" b JOIN sdc."CLINIC" c USING("Clinic_ID") WHERE b."Patient_ID"=$1 ORDER BY b."Appointment_Date" DESC,b."Start_Time" DESC LIMIT 10`,
          [p.Patient_ID],
        ),
        getPool().query(
          `SELECT COALESCE(SUM(total_amount),0)::text total,COALESCE(SUM(paid_amount),0)::text paid,COALESCE(SUM(remaining_amount),0)::text remaining FROM sdc.invoice_balances WHERE "Patient_ID"=$1 AND "Invoice_Status"='issued'`,
          [p.Patient_ID],
        ),
      ]);
      C.page(req, res, "patient/index", "مرحبًا " + p.First_Name, [
        {
          title: p.Health_Profile_Completed_At
            ? "الملف الصحي مكتمل"
            : "أكمل معلوماتك الصحية قبل الزيارة",
          links: [
            { href: "/patient/profile", label: "تحديث معلوماتي" },
            { href: "/patient/book-appointment", label: "حجز موعد" },
            { href: "/patient/ai-diagnosis", label: "مساعد الأعراض" },
          ],
        },
        T("آخر المواعيد", bookings.rows, [
          col("id", "الحجز", (r) => "/patient/booking-details?id=" + r.id),
          col("date", "التاريخ"),
          col("time", "الوقت"),
          col("clinic", "العيادة"),
          col("status", "الحالة"),
        ]),
        T("حساب الفواتير", bills.rows, [
          col("total", "المجموع ₪"),
          col("paid", "المدفوع ₪"),
          col("remaining", "المتبقي ₪"),
        ]),
      ]);
    }),
  );
  router.get(
    "/patient/invoices",
    C.route(async (req, res) => {
      const p = await profile(C.actor(req, ["patient"]).userId);
      const r = await getPool().query(
        `SELECT i."Invoice_ID"::text id,i."Created_At" created,c."Clinic_Name" clinic,i."Invoice_Status" status,i.total_amount total,i.paid_amount paid,i.remaining_amount remaining FROM sdc.invoice_balances i JOIN sdc."CLINIC" c USING("Clinic_ID") WHERE i."Patient_ID"=$1 AND i."Invoice_Status" IN ('issued','void') ORDER BY i."Created_At" DESC LIMIT 250`,
        [p.Patient_ID],
      );
      C.page(req, res, "patient/invoices", "فواتيري", [
        T("الفواتير والرصيد", r.rows, [
          col("id", "الفاتورة", (r) => "/patient/invoice?id=" + r.id),
          col("clinic", "العيادة"),
          col("created", "التاريخ"),
          col("status", "الحالة"),
          col("total", "المجموع ₪"),
          col("paid", "المدفوع ₪"),
          col("remaining", "المتبقي ₪"),
        ]),
      ]);
    }),
  );
  router.get(
    "/patient/notifications",
    C.route(async (req, res) => {
      const a = C.actor(req, ["patient"]);
      const r = await getPool().query(
        `SELECT "Notification_ID"::text id,"Title" title,"Body" body,"Created_At" created,CASE WHEN "Read_At" IS NULL THEN 'جديد' ELSE 'مقروء' END status FROM sdc."NOTIFICATION" WHERE "User_ID"=$1 ORDER BY "Created_At" DESC LIMIT 200`,
        [a.userId],
      );
      C.page(req, res, "patient/notifications", "إشعاراتي", [
        T("آخر الإشعارات", r.rows, [
          col("title", "العنوان"),
          col("body", "التفاصيل"),
          col("created", "التاريخ"),
          col("status", "الحالة"),
        ]),
        form(
          "قراءة الإشعارات",
          "/patient/notifications/read",
          [],
          {},
          "تحديد الكل كمقروء",
        ),
      ]);
    }),
  );
  router.post(
    "/patient/notifications/read",
    express.urlencoded({ extended: false, limit: "4kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["patient"]);
      await getPool().query(
        'UPDATE sdc."NOTIFICATION" SET "Read_At"=LOCALTIMESTAMP WHERE "User_ID"=$1 AND "Read_At" IS NULL',
        [a.userId],
      );
      res.redirect(303, "/patient/notifications?saved=1");
    }),
  );
  router.get(
    "/patient/diagnosis-history",
    C.route(async (req, res) => {
      const p = await profile(C.actor(req, ["patient"]).userId);
      const r = await getPool().query(
        `SELECT v."Visit_ID"::text id,v."Chief_Complaint" complaint,v."Visit_Status" status,b."Appointment_Date"::text date,c."Clinic_Name" clinic,v."Report_Approved_At" approved FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") JOIN sdc."CLINIC" c USING("Clinic_ID") WHERE b."Patient_ID"=$1 ORDER BY b."Appointment_Date" DESC LIMIT 250`,
        [p.Patient_ID],
      );
      C.page(req, res, "patient/diagnosis-history", "سجل زياراتي", [
        T("الزيارات", r.rows, [
          col("id", "الزيارة", (r) => "/patient/visit?id=" + r.id),
          col("date", "التاريخ"),
          col("clinic", "العيادة"),
          col("complaint", "الشكوى"),
          col("status", "الحالة"),
          col("approved", "اعتماد التقرير"),
        ]),
      ]);
    }),
  );
  router.get(
    "/patient/appointment-details",
    C.route(async (req, res) => {
      C.actor(req, ["patient"]);
      res.redirect(303, "/patient/booking-details?id=" + C.id(req.query.id));
    }),
  );
  router.get(
    "/patient/visit",
    C.route(async (req, res) => {
      const p = await profile(C.actor(req, ["patient"]).userId);
      const r = await getPool().query(
        `SELECT v."Visit_ID" id,v."Chief_Complaint" complaint,v."Examination_Notes" examination,v."Recommendations" advice,v."Report_Approved_At" approved FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") WHERE v."Visit_ID"=$1 AND b."Patient_ID"=$2`,
        [C.id(req.query.id), p.Patient_ID],
      );
      if (!r.rowCount) throw C.error("الزيارة غير موجودة.", 404);
      const v = r.rows[0];
      const sections = [{ title: "الشكوى", text: v.complaint }];
      if (v.approved) {
        sections.push(
          {
            title: "الفحص والتوصيات المعتمدة",
            text: [v.examination, v.advice].filter(Boolean).join("\n"),
          },
          {
            title: "التقرير المعتمد",
            links: [
              { href: "/patient/report/file?id=" + v.id, label: "تحميل PDF" },
            ],
          },
        );
      } else
        sections.push({
          title: "التقرير قيد الإعداد",
          text: "تظهر تفاصيل التقرير بعد اعتماد الطبيب.",
        });
      C.page(req, res, "patient/diagnosis-history", "تفاصيل الزيارة", sections);
    }),
  );
  router.get(
    "/patient/report/file",
    C.route(async (req, res) => {
      const p = await profile(C.actor(req, ["patient"]).userId);
      const r = await getPool().query(
        `SELECT v."Approved_Report_File_Reference" ref FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") WHERE v."Visit_ID"=$1 AND b."Patient_ID"=$2 AND v."Report_Approved_At" IS NOT NULL`,
        [C.id(req.query.id), p.Patient_ID],
      );
      const file = r.rowCount
        ? await require("../doctor-workspace/report-pdf").find(r.rows[0].ref)
        : null;
      if (!file) throw C.error("التقرير غير موجود.", 404);
      res.set("Cache-Control", "private, no-store");
      res.download(file, "medical-report.pdf");
    }),
  );
}
module.exports = {
  attach,
  profile,
  saveHealth,
  accountSave,
  accountSection,
  col,
  options,
};
