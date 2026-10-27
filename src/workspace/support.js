"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { col, options } = require("./patient");
function attach(router) {
  router.get(
    "/account/support",
    C.route(async (req, res) => {
      if (!req.sdcActor) return res.redirect(303, "/auth/login");
      const a = C.actor(req, ["patient", "doctor", "staff", "admin"]);
      const admin = a.role === "admin";
      const r = await getPool().query(
        'SELECT "Ticket_ID"::text id,"Subject" subject,"Message" message,"Status" status,"Reply" reply,"Created_At" created FROM sdc."SUPPORT_TICKETS" WHERE ($1::boolean OR "User_ID"=$2) ORDER BY "Created_At" DESC LIMIT 200',
        [admin, a.userId],
      );
      const slug =
        a.role === "doctor"
          ? "doctor/index"
          : a.role === "admin"
            ? "admin/index"
            : a.role === "staff"
              ? "staff/index"
              : "patient/profile";
      const sections = [
        {
          title: "الدعم الفني",
          text: "أرسل مشكلة تقنية دون معلومات طبية حساسة. يظهر رد الإدارة هنا عند معالجة الطلب؛ هذه ليست محادثة فورية.",
        },
        C.table("طلبات الدعم", r.rows, [
          col("id", "الطلب"),
          col("subject", "الموضوع"),
          col("message", "الرسالة"),
          col("status", "الحالة"),
          col("reply", "رد الإدارة"),
          col("created", "التاريخ"),
        ]),
        C.form("طلب دعم جديد", "/account/support/create", [
          C.field("subject", "الموضوع"),
          C.field("message", "المشكلة التقنية", "", "textarea"),
        ]),
      ];
      if (admin && r.rows.length)
        sections.push(
          C.form("الرد على طلب", "/account/support/reply", [
            C.field(
              "ticket_id",
              "طلب الدعم",
              "",
              "select",
              r.rows.map((t) => ({
                value: t.id,
                label: t.id + " — " + t.subject,
              })),
            ),
            C.field("reply", "الرد", "", "textarea"),
            C.field(
              "status",
              "الحالة",
              "replied",
              "select",
              options([
                ["replied", "تم الرد"],
                ["closed", "مغلق"],
              ]),
            ),
          ]),
        );
      C.page(req, res, slug, "الدعم الفني", sections);
    }),
  );
  router.post(
    "/account/support/create",
    express.urlencoded({ extended: false, limit: "12kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["patient", "doctor", "staff", "admin"]),
        subject = C.text(req.body.subject),
        message = C.text(req.body.message, 4000);
      await C.tx(
        a.userId,
        async (db) => {
          const count = await db.query(
            'SELECT COUNT(*)::int n FROM sdc."SUPPORT_TICKETS" WHERE "User_ID"=$1 AND "Created_At">CURRENT_TIMESTAMP-INTERVAL \'1 day\'',
            [a.userId],
          );
          if (count.rows[0].n >= 5)
            throw C.error("بلغت الحد اليومي لطلبات الدعم.", 429);
          const r = await db.query(
            'INSERT INTO sdc."SUPPORT_TICKETS"("User_ID","Subject","Message") VALUES($1,$2,$3) RETURNING "Ticket_ID"',
            [a.userId, subject, message],
          );
          await C.audit(
            db,
            a.userId,
            "support.created",
            "SupportTicket",
            r.rows[0].Ticket_ID,
            "إنشاء طلب دعم فني",
          );
          return { id: String(r.rows[0].Ticket_ID) };
        },
        {
          op: "support.create",
          key: req.body.request_key,
          payload: { subject, message },
        },
      );
      res.redirect(303, "/account/support?saved=1");
    }),
  );
  router.post(
    "/account/support/reply",
    express.urlencoded({ extended: false, limit: "12kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["admin"]),
        id = C.id(req.body.ticket_id),
        reply = C.text(req.body.reply, 4000),
        status = C.text(req.body.status, 20);
      if (!["replied", "closed"].includes(status))
        throw C.error("حالة غير صالحة.");
      await C.tx(
        a.userId,
        async (db) => {
          const r = await db.query(
            'UPDATE sdc."SUPPORT_TICKETS" SET "Reply"=$2,"Status"=$3,"Replied_By"=$4,"Updated_At"=CURRENT_TIMESTAMP WHERE "Ticket_ID"=$1 RETURNING "User_ID"',
            [id, reply, status, a.userId],
          );
          if (!r.rowCount) throw C.error("طلب الدعم غير موجود.", 404);
          await C.notify(
            db,
            r.rows[0].User_ID,
            "رد على طلب الدعم الفني",
            "يمكنك مراجعة الرد في صفحة الدعم الفني.",
            "SupportTicket",
            id,
          );
          await C.audit(
            db,
            a.userId,
            "support.replied",
            "SupportTicket",
            id,
            "الرد على طلب الدعم",
          );
          return { id };
        },
        {
          op: "support.reply",
          key: req.body.request_key,
          payload: { id, reply, status },
        },
      );
      res.redirect(303, "/account/support?saved=1");
    }),
  );
}
module.exports = { attach };
