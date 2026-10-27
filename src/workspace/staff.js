"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { col, options } = require("./patient");
const { field: F, form, table: T } = C;
function attach(router) {
  router.get(
    "/staff/index",
    C.route(async (req, res) => {
      const clinic = C.clinic(req);
      const permissions = res.locals.staffPermissions;
      const can = (p) => require("../staff-access/policy").can(permissions, p);
      const sections = [];
      if (can("appointments.view")) {
        const r = await getPool().query(
          `SELECT "Booking_Status" status,COUNT(*)::int count FROM sdc."BOOKING" WHERE "Clinic_ID"=$1 AND "Appointment_Date"=(now() AT TIME ZONE 'Asia/Hebron')::date GROUP BY "Booking_Status"`,
          [clinic],
        );
        sections.push(
          T("مواعيد اليوم", r.rows, [
            col("status", "الحالة"),
            col("count", "العدد"),
          ]),
        );
      }
      if (can("payments.record") || can("invoices.view")) {
        const r = await getPool().query(
          `SELECT COALESCE(SUM(p."Amount"),0)::text total FROM sdc."RECORDS_PAYMENT" p JOIN sdc."INVOICE" i USING("Invoice_ID") WHERE i."Clinic_ID"=$1 AND p."Paid_At"::date=(now() AT TIME ZONE 'Asia/Hebron')::date`,
          [clinic],
        );
        sections.push(T("دفعات اليوم", r.rows, [col("total", "المجموع ₪")]));
      }
      sections.push({
        title: "مساحة العمل",
        links: [
          ["appointments.view", "/staff/appointments", "المواعيد"],
          ["patients.view_admin", "/staff/patients", "المرضى"],
          ["invoices.view", "/staff/invoices", "الفواتير"],
          ["lab_orders.view", "/staff/lab-cases", "المختبرات"],
        ]
          .filter(([p]) => can(p))
          .map(([, href, label]) => ({ href, label })),
      });
      C.page(req, res, "staff/index", "مساحة عملي", sections);
    }),
  );
  router.get(
    "/staff/patients",
    C.route(async (req, res) => {
      const clinic = C.clinic(req, "patients.view_admin");
      const rows = await require("../clinic-patients/service").list(
        getPool(),
        clinic,
      );
      const sections = [
        T("مرضى العيادة", rows, [
          col("id", "الرقم"),
          col("name", "المريض"),
          col("phone", "الهاتف"),
          col("email", "البريد"),
          col("status", "الحالة"),
          col("last_visit", "آخر زيارة"),
        ]),
      ];
      if (
        require("../staff-access/policy").can(
          res.locals.staffPermissions,
          "patients.create",
        )
      )
        sections.push(
          form("إضافة ملف مريض دون حساب دخول", "/staff/patients/create", [
            F("clinic_patient_first_name", "الاسم الأول"),
            F("clinic_patient_last_name", "اسم العائلة"),
            F("clinic_patient_birthdate", "تاريخ الميلاد", "", "date"),
            F(
              "clinic_patient_gender",
              "الجنس",
              "male",
              "select",
              options([
                ["male", "ذكر"],
                ["female", "أنثى"],
              ]),
            ),
            F("clinic_patient_phone", "الهاتف", "", "tel"),
            {
              ...F("clinic_patient_email", "البريد الإلكتروني", "", "email"),
              required: false,
            },
          ]),
        );
      C.page(req, res, "staff/patients", "مرضى العيادة", sections);
    }),
  );
  router.post(
    "/staff/patients/create",
    express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 }),
    C.post(async (req, res) => {
      const clinic = C.clinic(req, "patients.create");
      const result = await require("../clinic-patients/service").create(
        getPool(),
        clinic,
        req.sdcActor.userId,
        req.body,
      );
      if (result.status !== "ok")
        throw C.error(
          result.status === "exists"
            ? "يوجد ملف مطابق؛ لا يمكن ربط حساب بعيادة إضافية دون موافقة المريض."
            : "تحقق من بيانات المريض.",
          409,
        );
      res.redirect(303, "/staff/patients?saved=1");
    }),
  );
  router.get(
    "/staff/invoices",
    C.route(async (req, res) => {
      const clinic = C.clinic(req, "invoices.view");
      const rows = (
        await require("../clinic-finance-inventory-service").invoices(
          getPool(),
          clinic,
        )
      ).items;
      C.page(req, res, "staff/invoices", "فواتير العيادة", [
        T("الفواتير", rows, [
          col("id", "الفاتورة", (r) => "/staff/invoice?id=" + r.id),
          col("patient", "المريض"),
          col("status", "الحالة"),
          col("total", "الإجمالي ₪"),
          col("paid", "المدفوع ₪"),
          col("remaining", "المتبقي ₪"),
        ]),
        {
          title: "إعداد الفواتير",
          links: [
            {
              href: "/staff/billing",
              label: "الزيارات المكتملة ومسودات الفواتير",
            },
          ],
        },
      ]);
    }),
  );
  router.get(
    "/staff/lab-cases",
    C.route(async (req, res) => {
      const clinic = C.clinic(req, "lab_orders.view");
      const data = await require("../clinic-remaining-service").labs(
        getPool(),
        clinic,
      );
      C.page(req, res, "staff/lab-cases", "مختبرات العيادة", [
        T("المختبرات المرتبطة", data.labs, [
          col(
            "Laboratory_ID",
            "الرقم",
            (r) => "/staff/lab-details?lab=" + r.Laboratory_ID,
          ),
          col("Laboratory_Name", "المختبر"),
          col("Relationship_Status", "العلاقة"),
          col("open_cases", "الطلبات المفتوحة"),
          col("overdue_cases", "المتأخرة"),
        ]),
      ]);
    }),
  );
  router.get(
    "/staff/lab-details",
    C.route(async (req, res) => {
      const clinic = C.clinic(req, "lab_orders.view"),
        lab = C.id(req.query.lab);
      const data = await require("../clinic-remaining-service").labDetails(
        getPool(),
        clinic,
        lab,
      );
      if (!data) throw C.error("المختبر غير مرتبط بالعيادة.", 404);
      const sections = [
        T("الطلبات المخبرية", data.cases, [
          col("Lab_Order_ID", "الطلب"),
          col("patient_first", "اسم المريض"),
          col("patient_last", "العائلة"),
          col("Order_Status", "الحالة"),
          col("Expected_Delivery_Date", "موعد التسليم"),
          col("work", "العمل"),
        ]),
      ];
      if (
        require("../staff-access/policy").can(
          res.locals.staffPermissions,
          "lab_orders.update_delivery",
        )
      )
        sections.push(
          form(
            "تحديث تسليم طلب",
            "/staff/lab-delivery",
            [
              F(
                "order_id",
                "طلب المختبر",
                "",
                "select",
                data.cases.map((c) => ({
                  value: c.Lab_Order_ID,
                  label:
                    "طلب " +
                    c.Lab_Order_ID +
                    " — " +
                    c.patient_first +
                    " " +
                    c.patient_last,
                })),
              ),
              F(
                "action",
                "الإجراء",
                "sent",
                "select",
                options([
                  ["sent", "تسجيل الإرسال"],
                  ["received", "تسجيل الاستلام"],
                ]),
              ),
            ],
            { lab },
          ),
        );
      C.page(req, res, "staff/lab-details", "تفاصيل المختبر", sections);
    }),
  );
  router.post(
    "/staff/lab-delivery",
    express.urlencoded({ extended: false, limit: "8kb" }),
    C.post(async (req, res) => {
      const clinic = C.clinic(req, "lab_orders.update_delivery"),
        a = req.sdcActor,
        order = C.id(req.body.order_id),
        lab = C.id(req.body.lab),
        action = C.text(req.body.action, 30);
      if (!["sent", "received"].includes(action))
        throw C.error("إجراء غير صالح.");
      await C.tx(
        a.userId,
        async (db) => {
          const r = await db.query(
            `SELECT o."Order_Status" status FROM sdc."LAB_ORDER" o JOIN sdc."VISIT" v USING("Visit_ID") JOIN sdc."BOOKING" b USING("Booking_ID") WHERE o."Lab_Order_ID"=$1 AND o."Laboratory_ID"=$2 AND b."Clinic_ID"=$3 FOR UPDATE OF o`,
            [order, lab, clinic],
          );
          if (!r.rowCount) throw C.error("الطلب غير موجود.", 404);
          if (r.rows[0].status !== (action === "sent" ? "draft" : "sent"))
            throw C.error("تغيرت حالة الطلب؛ حدّث الصفحة.", 409);
          await db.query(
            action === "sent"
              ? `UPDATE sdc."LAB_ORDER" SET "Order_Status"='sent',"Sent_At"=LOCALTIMESTAMP WHERE "Lab_Order_ID"=$1`
              : `UPDATE sdc."LAB_ORDER" SET "Order_Status"='received',"Received_At"=LOCALTIMESTAMP WHERE "Lab_Order_ID"=$1`,
            [order],
          );
          await C.audit(
            db,
            a.userId,
            "lab.delivery." + action,
            "LabOrder",
            order,
            "تحديث تسليم طلب مختبر",
          );
        },
        {
          op: "lab.delivery",
          key: req.body.request_key,
          payload: { order, lab, action },
        },
      );
      res.redirect(303, "/staff/lab-details?lab=" + lab + "&saved=1");
    }),
  );
}
module.exports = { attach };
