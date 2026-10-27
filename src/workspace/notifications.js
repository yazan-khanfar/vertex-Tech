"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { col } = require("./patient");
async function locals(req, res, next) {
  try {
    if (req.sdcActor && res.locals.notificationCount === undefined) {
      const r = await getPool().query(
        'SELECT COUNT(*)::int n FROM sdc."NOTIFICATION" WHERE "User_ID"=$1 AND "Read_At" IS NULL',
        [req.sdcActor.userId],
      );
      res.locals.notificationCount = r.rows[0].n;
    }
    next();
  } catch (e) {
    next(e);
  }
}
function attach(router) {
  router.get(
    "/account/notifications",
    C.route(async (req, res) => {
      const a = C.actor(req, ["doctor", "staff", "patient", "admin"]);
      const r = await getPool().query(
        'SELECT "Title" title,"Body" body,"Created_At" created,"Read_At" read FROM sdc."NOTIFICATION" WHERE "User_ID"=$1 ORDER BY "Created_At" DESC LIMIT 200',
        [a.userId],
      );
      const slug =
        a.role === "doctor"
          ? "doctor/index"
          : a.role === "admin"
            ? "admin/index"
            : a.role === "staff"
              ? "staff/index"
              : "patient/notifications";
      C.page(req, res, slug, "إشعاراتي", [
        C.table("الإشعارات", r.rows, [
          col("title", "العنوان"),
          col("body", "التفاصيل"),
          col("created", "التاريخ"),
          col("read", "تاريخ القراءة"),
        ]),
        C.form(
          "قراءة الإشعارات",
          "/account/notifications/read",
          [],
          {},
          "تحديد الكل كمقروء",
        ),
      ]);
    }),
  );
  router.post(
    "/account/notifications/read",
    express.urlencoded({ extended: false, limit: "4kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["doctor", "staff", "patient", "admin"]);
      await getPool().query(
        'UPDATE sdc."NOTIFICATION" SET "Read_At"=LOCALTIMESTAMP WHERE "User_ID"=$1 AND "Read_At" IS NULL',
        [a.userId],
      );
      res.redirect(303, "/account/notifications?saved=1");
    }),
  );
}
module.exports = { attach, locals };
