"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const P = require("./patient");
const { field: F, form, table: T } = C;
const { col, options } = P;
const catalogs = {
  services: {
    table: "SERVICE",
    pk: "Service_ID",
    title: "الخدمات",
    fields: [["Service_Name", "اسم الخدمة"]],
  },
  specialties: {
    table: "SPECIALTY",
    pk: "Specialty_ID",
    title: "التخصصات",
    fields: [
      ["Name_AR", "الاسم العربي"],
      ["Name_EN", "الاسم الإنجليزي"],
      ["Is_Active", "نشط", "boolean"],
    ],
  },
  labs: {
    table: "LABORATORY",
    pk: "Laboratory_ID",
    title: "المختبرات",
    fields: [
      ["Laboratory_Name", "اسم المختبر"],
      ["Phone", "الهاتف"],
      ["Address", "العنوان"],
      ["Additional_Contact", "وسيلة اتصال إضافية", "optional"],
    ],
  },
};
const reports = {
  users: {
    title: "المستخدمون",
    sql: `SELECT u."User_ID"::text id,u."First_Name"||' '||u."Last_Name" name,u."Email" email,u."Account_Status" status,r."Role_Name" role FROM sdc."USER" u JOIN sdc."ROLE" r USING("Role_ID")`,
    columns: [
      col("id", "الرقم", (r) => "/admin/user-details?id=" + r.id),
      col("name", "الاسم"),
      col("email", "البريد"),
      col("role", "الدور"),
      col("status", "الحالة"),
    ],
  },
  finance: {
    title: "الفواتير والمالية",
    sql: `SELECT i."Invoice_ID"::text id,c."Clinic_Name" clinic,i."Invoice_Status" status,i.total_amount total,i.paid_amount paid,i.remaining_amount remaining FROM sdc.invoice_balances i JOIN sdc."CLINIC" c USING("Clinic_ID")`,
    columns: [
      col("id", "الفاتورة", (r) => "/admin/invoice-details?id=" + r.id),
      col("clinic", "العيادة"),
      col("status", "الحالة"),
      col("total", "الإجمالي ₪"),
      col("paid", "المدفوع ₪"),
      col("remaining", "المتبقي ₪"),
    ],
  },
  reports: {
    title: "تقارير تشغيل المنصة",
    sql: `SELECT c."Clinic_ID"::text id,c."Clinic_Name" clinic,(SELECT COUNT(*)::int FROM sdc."BOOKING" b WHERE b."Clinic_ID"=c."Clinic_ID") bookings,(SELECT COUNT(*)::int FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") WHERE b."Clinic_ID"=c."Clinic_ID" AND v."Visit_Status"='completed') visits,COALESCE((SELECT SUM(p."Amount") FROM sdc."RECORDS_PAYMENT" p JOIN sdc."INVOICE" i USING("Invoice_ID") WHERE i."Clinic_ID"=c."Clinic_ID"),0)::text collected FROM sdc."CLINIC" c`,
    columns: [
      col("id", "العيادة", (r) => "/admin/clinic-details?id=" + r.id),
      col("clinic", "الاسم"),
      col("bookings", "الحجوزات"),
      col("visits", "الزيارات المكتملة"),
      col("collected", "المحصل ₪"),
    ],
  },
  "staff-permissions": {
    title: "صلاحيات موظفي العيادات",
    sql: `SELECT s."User_ID"::text id,s."Clinic_ID"::text clinic_id,u."First_Name"||' '||u."Last_Name" name,c."Clinic_Name" clinic,s."Membership_Status" status,COALESCE(string_agg(p."Permission_Code",', '),'') permissions FROM sdc."STAFF_AT" s JOIN sdc."USER" u USING("User_ID") JOIN sdc."CLINIC" c USING("Clinic_ID") LEFT JOIN sdc."STAFF_PERMISSIONS" p USING("User_ID","Clinic_ID") GROUP BY s."User_ID",s."Clinic_ID",u."First_Name",u."Last_Name",c."Clinic_Name",s."Membership_Status"`,
    columns: [
      col(
        "id",
        "تعديل الصلاحيات",
        (r) =>
          "/admin/staff-permissions?user=" + r.id + "&clinic=" + r.clinic_id,
      ),
      col("name", "الاسم"),
      col("clinic_id", "رقم العيادة"),
      col("clinic", "العيادة"),
      col("status", "الحالة"),
      col("permissions", "الصلاحيات"),
    ],
  },
};
async function listing(req, res, slug, spec, extra = []) {
  C.actor(req, ["admin"]);
  const page = Math.max(
      1,
      Math.min(10000, parseInt(req.query.page || "1", 10) || 1),
    ),
    q = C.text(req.query.q || "", 100, false);
  const result = await getPool().query(
    `SELECT * FROM (${spec.sql}) x WHERE ($1='' OR row_to_json(x)::text ILIKE '%'||$1||'%') ORDER BY id LIMIT 50 OFFSET $2`,
    [q, (page - 1) * 50],
  );
  C.page(req, res, "admin/" + slug, spec.title, [
    { title: "البحث", text: "أضف ?q=نص إلى عنوان الصفحة للبحث في النتائج." },
    T(spec.title, result.rows, spec.columns),
    {
      title: "التنقل",
      links: [
        ...(page > 1
          ? [
              {
                href:
                  "/admin/" +
                  slug +
                  "?page=" +
                  (page - 1) +
                  "&q=" +
                  encodeURIComponent(q),
                label: "السابق",
              },
            ]
          : []),
        ...(result.rowCount === 50
          ? [
              {
                href:
                  "/admin/" +
                  slug +
                  "?page=" +
                  (page + 1) +
                  "&q=" +
                  encodeURIComponent(q),
                label: "التالي",
              },
            ]
          : []),
      ],
    },
    ...extra,
  ]);
}
function attach(router) {
  router.get(
    "/admin/index",
    C.route(async (req, res) => {
      C.actor(req, ["admin"]);
      const r = await getPool().query(
        `SELECT (SELECT COUNT(*)::int FROM sdc."USER" WHERE "Account_Status"='active') users,(SELECT COUNT(*)::int FROM sdc."CLINIC" WHERE "Approval_Status"='pending') pending_clinics,(SELECT COUNT(*)::int FROM sdc."DOCTOR" WHERE "License_Status"='pending') pending_doctors,(SELECT COALESCE(SUM(remaining_amount),0)::text FROM sdc.settlement_balances) settlement_due`,
      );
      C.page(req, res, "admin/index", "لوحة إدارة المنصة", [
        T("الوضع الحالي", r.rows, [
          col("users", "الحسابات النشطة"),
          col("pending_clinics", "عيادات تنتظر المراجعة"),
          col("pending_doctors", "تراخيص تنتظر المراجعة"),
          col("settlement_due", "تسويات متبقية ₪"),
        ]),
        {
          title: "الإدارة",
          links: [
            ["approvals", "طلبات اعتماد العيادات"],
            ["doctors", "الأطباء والتراخيص"],
            ["users", "الحسابات"],
            ["management-center", "مركز الإدارة"],
            ["finance", "المالية"],
            ["reports", "التقارير"],
          ].map(([s, label]) => ({ href: "/admin/" + s, label })),
        },
      ]);
    }),
  );
  for (const [slug, spec] of Object.entries(reports))
    router.get(
      "/admin/" + slug,
      C.route(async (req, res) =>
        listing(
          req,
          res,
          slug,
          spec,
          slug === "finance"
            ? [
                {
                  title: "تسويات المنصة",
                  links: [
                    { href: "/admin/settlements", label: "إدارة التسويات" },
                  ],
                },
              ]
            : slug === "staff-permissions"
              ? await permissionSections(req)
              : [],
        ),
      ),
    );
  router.get(
    "/admin/management-center",
    C.route(async (req, res) => {
      C.actor(req, ["admin"]);
      C.page(req, res, "admin/management-center", "مركز الإدارة", [
        {
          title: "إدارة البيانات والصلاحيات",
          links: [
            "services",
            "specialties",
            "labs",
            "users",
            "staff-permissions",
            "settings",
          ].map((s) => ({
            href: "/admin/" + s,
            label: {
              services: "الخدمات",
              specialties: "التخصصات",
              labs: "المختبرات",
              users: "المستخدمون",
              "staff-permissions": "الصلاحيات",
              settings: "الإعدادات",
            }[s],
          })),
        },
      ]);
    }),
  );
  for (const [slug, spec] of Object.entries(catalogs)) {
    router.get(
      "/admin/" + slug,
      C.route(async (req, res) => {
        C.actor(req, ["admin"]);
        const edit = req.query.edit ? C.id(req.query.edit) : null;
        const rows = await getPool().query(
          `SELECT "${spec.pk}"::text id,${spec.fields.map(([n]) => '"' + n + '"').join(",")} FROM sdc."${spec.table}" ORDER BY "${spec.pk}" LIMIT 500`,
        );
        const current = edit ? rows.rows.find((x) => x.id === edit) : {};
        if (edit && !current) throw C.error("السجل غير موجود.", 404);
        C.page(req, res, "admin/" + slug, spec.title, [
          T(spec.title, rows.rows, [
            col("id", "الرقم", (r) => "/admin/" + slug + "?edit=" + r.id),
            ...spec.fields.map(([n, label]) => col(n, label)),
          ]),
          form(
            edit ? "تعديل السجل" : "إضافة سجل",
            "/admin/catalog/" + slug,
            spec.fields.map(([n, label, type]) => ({
              ...F(
                n,
                label,
                current[n] ?? (type === "boolean" ? "true" : ""),
                type === "boolean" ? "select" : "text",
                type === "boolean"
                  ? options([
                      ["true", "نشط"],
                      ["false", "غير نشط"],
                    ])
                  : undefined,
              ),
              required: type !== "optional",
            })),
            { id: edit || "" },
          ),
        ]);
      }),
    );
    router.post(
      "/admin/catalog/" + slug,
      express.urlencoded({
        extended: false,
        limit: "12kb",
        parameterLimit: 15,
      }),
      C.post(async (req, res) => {
        const a = C.actor(req, ["admin"]),
          id = req.body.id ? C.id(req.body.id) : null;
        const values = spec.fields.map(([n, , type]) => {
          if (type === "boolean") {
            if (!["true", "false"].includes(req.body[n]))
              throw C.error("قيمة حالة غير صالحة.");
            return req.body[n] === "true";
          }
          return C.text(req.body[n] || "", 150, type !== "optional") || null;
        });
        await C.tx(a.userId, async (db) => {
          let result;
          if (id) {
            result = await db.query(
              `UPDATE sdc."${spec.table}" SET ${spec.fields.map(([n], i) => '"' + n + '"=$' + (i + 1)).join(",")} WHERE "${spec.pk}"=$${values.length + 1} RETURNING "${spec.pk}"`,
              [...values, id],
            );
            if (!result.rowCount) throw C.error("السجل غير موجود.", 404);
          } else
            result = await db.query(
              `INSERT INTO sdc."${spec.table}"(${spec.fields.map(([n]) => '"' + n + '"').join(",")}) VALUES(${values.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING "${spec.pk}"`,
              values,
            );
          await C.audit(
            db,
            a.userId,
            "catalog." + (id ? "updated" : "created"),
            spec.table,
            result.rows[0][spec.pk],
            "إدارة سجل مرجعي",
          );
        });
        res.redirect(303, "/admin/" + slug + "?saved=1");
      }),
    );
  }
  router.get(
    "/admin/user-details",
    C.route(async (req, res) => {
      C.actor(req, ["admin"]);
      const id = C.id(req.query.id),
        r = await getPool().query(
          `SELECT u."User_ID"::text id,u."First_Name"||' '||u."Last_Name" name,u."Email" email,u."Phone" phone,u."Account_Status" status,r."Role_Name" role FROM sdc."USER" u JOIN sdc."ROLE" r USING("Role_ID") WHERE u."User_ID"=$1`,
          [id],
        );
      if (!r.rowCount) throw C.error("الحساب غير موجود.", 404);
      C.page(req, res, "admin/user-details", "تفاصيل المستخدم", [
        T("الحساب", r.rows, [
          col("name", "الاسم"),
          col("email", "البريد"),
          col("phone", "الهاتف"),
          col("role", "الدور"),
          col("status", "الحالة"),
        ]),
        form(
          "إدارة حالة الحساب",
          "/admin/user-status",
          [
            F(
              "status",
              "الحالة",
              r.rows[0].status,
              "select",
              options([
                ["active", "نشط"],
                ["suspended", "موقوف"],
                ["disabled", "معطل"],
              ]),
            ),
            F("reason", "سبب التغيير"),
          ],
          { user_id: id },
        ),
      ]);
    }),
  );
  router.post(
    "/admin/user-status",
    express.urlencoded({ extended: false, limit: "8kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["admin"]),
        id = C.id(req.body.user_id),
        status = C.text(req.body.status, 30),
        reason = C.text(req.body.reason, 1000);
      if (
        !["active", "suspended", "disabled"].includes(status) ||
        id === a.userId
      )
        throw C.error(
          "لا يمكن تنفيذ هذا التغيير على حسابك أو بهذه الحالة.",
          403,
        );
      await C.tx(a.userId, async (db) => {
        const r = await db.query(
          'UPDATE sdc."USER" SET "Account_Status"=$2 WHERE "User_ID"=$1 RETURNING "User_ID"',
          [id, status],
        );
        if (!r.rowCount) throw C.error("الحساب غير موجود.", 404);
        await db.query(
          'UPDATE sdc."USER_SESSIONS" SET "Revoked_At"=GREATEST("Started_At",LOCALTIMESTAMP) WHERE "User_ID"=$1 AND "Revoked_At" IS NULL',
          [id],
        );
        await C.audit(db, a.userId, "user.status.updated", "User", id, reason);
      });
      require("../auth/session").revokeUserSessions(id);
      res.redirect(303, "/admin/user-details?id=" + id + "&saved=1");
    }),
  );
  router.post(
    "/admin/permissions/save",
    express.urlencoded({ extended: false, limit: "12kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["admin"]),
        user = C.id(req.body.user_id),
        clinic = C.id(req.body.clinic_id),
        perms =
          req.body.permissions === undefined
            ? require("../clinic-staff/service").PERMISSIONS.filter(
                (_, i) => req.body["permission_" + i] === "on",
              )
            : [
                ...new Set(
                  C.text(req.body.permissions || "", 4000, false)
                    .split(/\s+/)
                    .filter(Boolean),
                ),
              ];
      if (
        perms.some(
          (p) => !require("../clinic-staff/service").PERMISSIONS.includes(p),
        )
      )
        throw C.error("رمز صلاحية غير معتمد.");
      await C.tx(a.userId, async (db) => {
        const r = await db.query(
          'SELECT 1 FROM sdc."STAFF_AT" WHERE "User_ID"=$1 AND "Clinic_ID"=$2 FOR UPDATE',
          [user, clinic],
        );
        if (!r.rowCount) throw C.error("عضوية الموظف غير موجودة.", 404);
        await db.query(
          'DELETE FROM sdc."STAFF_PERMISSIONS" WHERE "User_ID"=$1 AND "Clinic_ID"=$2',
          [user, clinic],
        );
        for (const p of perms)
          await db.query(
            'INSERT INTO sdc."STAFF_PERMISSIONS"("User_ID","Clinic_ID","Permission_Code") VALUES($1,$2,$3)',
            [user, clinic, p],
          );
        await C.audit(
          db,
          a.userId,
          "staff.permissions.updated",
          "User",
          user,
          "تغيير صلاحيات الموظف في العيادة " + clinic,
        );
      });
      res.redirect(303, "/admin/staff-permissions?saved=1");
    }),
  );
  router.get(
    "/admin/settings",
    C.route(async (req, res) => {
      C.actor(req, ["admin"]);
      const r = await getPool().query(
        'SELECT "Setting_Key" key,"Setting_Value" value FROM sdc."PLATFORM_SETTINGS" ORDER BY "Setting_Key"',
      );
      C.page(
        req,
        res,
        "admin/settings",
        "إعدادات المنصة",
        [
          T("الإعدادات العامة", r.rows, [
            col("key", "الإعداد"),
            col("value", "القيمة"),
          ]),
          form("اسم المنصة", "/admin/settings/save", [
            F(
              "platform_name",
              "الاسم",
              r.rows.find((x) => x.key === "platform_name")?.value ||
                "Smart Dental Clinic",
            ),
          ]),
        ],
        await require("./accounts").securityData(req),
      );
    }),
  );
  router.post(
    "/admin/settings/save",
    express.urlencoded({ extended: false, limit: "4kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["admin"]),
        name = C.text(req.body.platform_name);
      await C.tx(a.userId, async (db) => {
        await db.query(
          `INSERT INTO sdc."PLATFORM_SETTINGS"("Setting_Key","Setting_Value","Updated_By") VALUES('platform_name',$1,$2) ON CONFLICT("Setting_Key") DO UPDATE SET "Setting_Value"=EXCLUDED."Setting_Value","Updated_By"=EXCLUDED."Updated_By","Updated_At"=CURRENT_TIMESTAMP`,
          [name, a.userId],
        );
        await C.audit(
          db,
          a.userId,
          "platform.settings.updated",
          "Setting",
          "platform_name",
          "تحديث اسم المنصة",
        );
      });
      require("./settings").invalidate();
      res.redirect(303, "/admin/settings?saved=1");
    }),
  );
  attachDetails(router);
  router.post(
    "/admin/clinic-status",
    express.urlencoded({ extended: false, limit: "8kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["admin"]),
        id = C.id(req.body.clinic_id),
        status = C.text(req.body.status, 30),
        reason = C.text(req.body.reason, 1000);
      if (!["active", "suspended", "inactive"].includes(status))
        throw C.error("حالة غير صالحة.");
      await C.tx(a.userId, async (db) => {
        const r = await db.query(
          'UPDATE sdc."CLINIC" SET "Clinic_Status"=$2 WHERE "Clinic_ID"=$1 RETURNING "Clinic_ID"',
          [id, status],
        );
        if (!r.rowCount) throw C.error("العيادة غير موجودة.", 404);
        await C.audit(
          db,
          a.userId,
          "clinic.status.updated",
          "Clinic",
          id,
          reason,
        );
      });
      res.redirect(303, "/admin/clinic-details?id=" + id + "&saved=1");
    }),
  );
}
function attachDetails(router) {
  const definitions = {
    "doctor-details": {
      title: "تفاصيل الطبيب",
      sql: `SELECT d."Doctor_ID"::text id,u."First_Name"||' '||u."Last_Name" name,u."Email" email,d."License_Number" license,d."License_Status" status,d."Years_Of_Experience" experience,d."Bio" bio FROM sdc."DOCTOR" d JOIN sdc."USER" u USING("User_ID") WHERE d."Doctor_ID"=$1`,
      columns: [
        col("name", "الاسم"),
        col("email", "البريد"),
        col("license", "الترخيص"),
        col("status", "حالة الترخيص"),
        col("experience", "الخبرة"),
        col("bio", "النبذة"),
      ],
    },
    "appointment-details": {
      title: "تفاصيل الموعد",
      sql: `SELECT b."Booking_ID"::text id,b."Appointment_Date"::text date,b."Start_Time"::text time,b."Booking_Status" status,c."Clinic_Name" clinic,u."First_Name"||' '||u."Last_Name" patient,b."Service_Price_Snapshot" price FROM sdc."BOOKING" b JOIN sdc."CLINIC" c USING("Clinic_ID") JOIN sdc."PATIENT" p USING("Patient_ID") JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE b."Booking_ID"=$1`,
      columns: [
        col("id", "الحجز"),
        col("date", "التاريخ"),
        col("time", "الوقت"),
        col("clinic", "العيادة"),
        col("patient", "المريض"),
        col("status", "الحالة"),
        col("price", "سعر الخدمة ₪"),
      ],
    },
    "medical-record-details": {
      title: "السجل الطبي",
      sql: `SELECT v."Visit_ID"::text id,v."Chief_Complaint" complaint,v."Examination_Notes" examination,v."Recommendations" advice,v."Report_Approved_At" approved,c."Clinic_Name" clinic,u."First_Name"||' '||u."Last_Name" patient FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") JOIN sdc."CLINIC" c USING("Clinic_ID") JOIN sdc."PATIENT" p USING("Patient_ID") JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE v."Visit_ID"=$1`,
      columns: [
        col("patient", "المريض"),
        col("clinic", "العيادة"),
        col("complaint", "الشكوى"),
        col("examination", "الفحص"),
        col("advice", "التوصيات"),
        col("approved", "الاعتماد"),
      ],
    },
    "lab-details": {
      title: "تفاصيل المختبر",
      sql: `SELECT "Laboratory_ID"::text id,"Laboratory_Name" name,"Phone" phone,"Address" address,"Additional_Contact" contact FROM sdc."LABORATORY" WHERE "Laboratory_ID"=$1`,
      columns: [
        col("name", "المختبر"),
        col("phone", "الهاتف"),
        col("address", "العنوان"),
        col("contact", "وسيلة اتصال إضافية"),
      ],
    },
    "job-details": {
      title: "تفاصيل الوظيفة",
      sql: `SELECT j."Job_ID"::text id,j."Job_Title" title,c."Clinic_Name" clinic,j."Job_Status" status,j."Summary" summary,j."Requirements" requirements,j."Application_Deadline" deadline FROM sdc."JOB" j JOIN sdc."CLINIC" c USING("Clinic_ID") WHERE j."Job_ID"=$1`,
      columns: [
        col("title", "الوظيفة"),
        col("clinic", "العيادة"),
        col("status", "الحالة"),
        col("summary", "الوصف"),
        col("requirements", "المتطلبات"),
        col("deadline", "الموعد النهائي"),
      ],
    },
    "job-application-details": {
      title: "طلب التوظيف",
      sql: `SELECT a."Application_ID"::text id,a."Full_Name" name,a."Email" email,a."Specialty_Name" specialty,a."Application_Status" status,a."Cover_Letter" cover,a."Clinic_Feedback" feedback,j."Job_Title" job FROM sdc."APPLIES_FOR" a JOIN sdc."JOB" j USING("Job_ID") WHERE a."Application_ID"=$1`,
      columns: [
        col("name", "الطبيب"),
        col("email", "البريد"),
        col("specialty", "التخصص"),
        col("job", "الوظيفة"),
        col("status", "الحالة"),
        col("cover", "الرسالة"),
        col("feedback", "ملاحظة العيادة"),
      ],
    },
  };
  for (const [slug, spec] of Object.entries(definitions))
    router.get(
      "/admin/" + slug,
      C.route(async (req, res) => {
        C.actor(req, ["admin"]);
        const r = await getPool().query(spec.sql, [
          C.id(req.query.id || req.query.lab || req.query.job),
        ]);
        if (!r.rowCount) throw C.error("السجل غير موجود.", 404);
        C.page(req, res, "admin/" + slug, spec.title, [
          T(spec.title, r.rows, spec.columns),
        ]);
      }),
    );
}
async function doctors(req, res) {
  C.actor(req, ["admin"]);
  return listing(req, res, "doctors", {
    title: "الأطباء والتراخيص",
    sql: `SELECT d."Doctor_ID"::text id,u."First_Name"||' '||u."Last_Name" name,u."Email" email,d."License_Number" license,d."License_Status" status FROM sdc."DOCTOR" d JOIN sdc."USER" u USING("User_ID")`,
    columns: [
      col(
        "id",
        "مراجعة الترخيص",
        (r) => "/admin/doctor-license-review?id=" + r.id,
      ),
      col("name", "الملف المهني", (r) => "/admin/doctor-details?id=" + r.id),
      col("email", "البريد"),
      col("license", "الترخيص"),
      col("status", "الحالة"),
    ],
  });
}
async function clinicDetails(req, res) {
  C.actor(req, ["admin"]);
  const id = C.id(req.query.id);
  const r = await getPool().query(
    'SELECT "Clinic_ID"::text id,"Clinic_Name" name,"City" city,"Clinic_Email" email,"Clinic_Phone" phone,"Approval_Status" approval,"Clinic_Status" status FROM sdc."CLINIC" WHERE "Clinic_ID"=$1',
    [id],
  );
  if (!r.rowCount) throw C.error("العيادة غير موجودة.", 404);
  const [doctors, services, bookings, staff] = await Promise.all([
    getPool().query(
      `SELECT d."Doctor_ID"::text id,u."First_Name"||' '||u."Last_Name" name,w."Membership_Status" status FROM sdc."WORKS_AT" w JOIN sdc."DOCTOR" d USING("Doctor_ID") JOIN sdc."USER" u USING("User_ID") WHERE w."Clinic_ID"=$1`,
      [id],
    ),
    getPool().query(
      `SELECT s."Service_Name" name,o."Price" price,o."Duration_Minutes" duration,o."Is_Available" available FROM sdc."OFFERS" o JOIN sdc."SERVICE" s USING("Service_ID") WHERE o."Clinic_ID"=$1`,
      [id],
    ),
    getPool().query(
      `SELECT "Booking_ID"::text id,"Appointment_Date"::text date,"Booking_Status" status FROM sdc."BOOKING" WHERE "Clinic_ID"=$1 ORDER BY "Appointment_Date" DESC LIMIT 50`,
      [id],
    ),
    require("../clinic-staff/service").list(getPool(), id),
  ]);
  C.page(req, res, "admin/clinic-details", r.rows[0].name, [
    T("العيادة", r.rows, [
      col("city", "المدينة"),
      col("email", "البريد"),
      col("phone", "الهاتف"),
      col("approval", "الاعتماد"),
      col("status", "الحالة"),
    ]),
    T("الأطباء", doctors.rows, [
      col("name", "الطبيب", (r) => "/admin/doctor-details?id=" + r.id),
      col("status", "العضوية"),
    ]),
    T("الخدمات", services.rows, [
      col("name", "الخدمة"),
      col("price", "السعر ₪"),
      col("duration", "المدة"),
      col("available", "متاحة"),
    ]),
    T("المواعيد", bookings.rows, [
      col("id", "الحجز", (r) => "/admin/appointment-details?id=" + r.id),
      col("date", "التاريخ"),
      col("status", "الحالة"),
    ]),
    T("الموظفون", staff, [
      col("name", "الاسم"),
      col("roleLabel", "الدور"),
      col("status", "العضوية"),
    ]),
    form(
      "إدارة حالة العيادة",
      "/admin/clinic-status",
      [
        F(
          "status",
          "الحالة",
          r.rows[0].status,
          "select",
          options([
            ["active", "نشطة"],
            ["suspended", "موقوفة"],
            ["inactive", "غير نشطة"],
          ]),
        ),
        F("reason", "سبب التغيير"),
      ],
      { clinic_id: id },
    ),
    {
      title: "مراجعة الاعتماد والمستندات",
      links: [
        {
          href: "/admin/clinic-application-details?id=" + id,
          label: "فتح ملف اعتماد العيادة",
        },
      ],
    },
  ]);
}
module.exports = { attach, doctors, clinicDetails };

async function permissionSections(req) {
  if (!req.query.user || !req.query.clinic)
    return [
      {
        title: "إدارة الصلاحيات",
        text: "اختر الموظف من الجدول لعرض وتعديل صلاحياته في العيادة المحددة.",
      },
    ];
  const user = C.id(req.query.user),
    clinic = C.id(req.query.clinic);
  const r = await getPool().query(
    `SELECT u."First_Name"||' '||u."Last_Name" name,c."Clinic_Name" clinic FROM sdc."STAFF_AT" s JOIN sdc."USER" u USING("User_ID") JOIN sdc."CLINIC" c USING("Clinic_ID") WHERE s."User_ID"=$1 AND s."Clinic_ID"=$2`,
    [user, clinic],
  );
  if (!r.rowCount) throw C.error("عضوية الموظف غير موجودة.", 404);
  const selected = new Set(
    (
      await getPool().query(
        'SELECT "Permission_Code" code FROM sdc."STAFF_PERMISSIONS" WHERE "User_ID"=$1 AND "Clinic_ID"=$2',
        [user, clinic],
      )
    ).rows.map((x) => x.code),
  );
  const labels = {
    "appointments.view": "عرض المواعيد",
    "appointments.manage": "إدارة المواعيد وتسجيل الوصول",
    "patients.view_admin": "عرض بيانات المرضى الإدارية",
    "patients.create": "إضافة ملف مريض",
    "invoices.view": "عرض الفواتير",
    "payments.record": "تسجيل دفعات",
    "reports.view_operational": "عرض تقارير التشغيل",
    "lab_orders.view": "عرض طلبات المختبر",
    "lab_orders.update_delivery": "تحديث تسليم طلبات المختبر",
    "laboratories.manage": "إدارة ارتباط المختبرات",
    "invoices.issue": "إعداد وإصدار الفواتير",
  };
  return [
    form(
      "صلاحيات " + r.rows[0].name + " — " + r.rows[0].clinic,
      "/admin/permissions/save",
      require("../clinic-staff/service").PERMISSIONS.map((code, i) => ({
        ...F("permission_" + i, labels[code], selected.has(code), "checkbox"),
        required: false,
      })),
      { user_id: user, clinic_id: clinic },
      "حفظ الصلاحيات",
    ),
  ];
}
