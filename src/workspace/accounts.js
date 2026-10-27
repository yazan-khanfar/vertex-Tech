"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const P = require("./patient");
async function securityData(req) {
  const scope = req.sdcActor.role;
  const session = require("../auth/session");
  return {
    security: true,
    securityScope: scope,
    mfaView: await require("../mfa/profile-page").mfaViewFor(req),
    passwordChangeCsrf: session.sessionCsrf(req),
    passwordChangeError:
      require("../password-reset/profile-destinations").passwordError(
        req.query.password_error,
      ),
    passwordChangeReference: "",
    accountSessions: await session.listTrackedSessions(
      getPool(),
      req.sdcActor.userId,
      req.sdcSession.sessionId,
    ),
    sessionActionCsrf: session.sessionCsrf(req),
    sessionActionMessage:
      req.query.sessions === "updated" ? "تم تحديث الجلسات." : "",
  };
}
async function settings(req, res) {
  const a = C.actor(req, ["doctor", "staff", "patient"]);
  const slug = a.role === "doctor" ? "doctor/settings" : a.role + "/profile";
  const sections = [await P.accountSection(a.userId, "/account/profile/save")];
  if (a.role === "doctor") {
    const r = await getPool().query(
      'SELECT "Bio","Years_Of_Experience" FROM sdc."DOCTOR" WHERE "Doctor_ID"=$1 AND "User_ID"=$2',
      [a.doctorId, a.userId],
    );
    sections.push(
      C.form("الملف المهني", "/account/doctor/save", [
        {
          ...C.field("bio", "نبذة مهنية", r.rows[0].Bio, "textarea"),
          required: false,
        },
        C.field(
          "experience",
          "سنوات الخبرة",
          r.rows[0].Years_Of_Experience || 0,
          "number",
        ),
      ]),
    );
  }
  C.page(req, res, slug, "إعدادات حسابي", sections, await securityData(req));
}
function attach(router) {
  for (const path of [
    "/account/profile",
    "/doctor/settings",
    "/staff/profile",
    "/patient/security",
  ])
    router.get(path, C.route(settings));
  const body = express.urlencoded({
    extended: false,
    limit: "16kb",
    parameterLimit: 15,
  });
  router.post(
    "/account/profile/save",
    body,
    C.post(async (req, res) => {
      const a = C.actor(req, ["patient", "doctor", "staff"]);
      await P.accountSave(a.userId, req.body);
      res.redirect(
        303,
        a.role === "patient"
          ? "/patient/profile?saved=1"
          : "/account/profile?saved=1",
      );
    }),
  );
  router.post(
    "/account/doctor/save",
    body,
    C.post(async (req, res) => {
      const a = C.actor(req, ["doctor"]),
        bio = C.text(req.body.bio || "", 5000, false),
        experience = String(req.body.experience);
      if (!/^\d{1,2}$/.test(experience) || Number(experience) > 80)
        throw C.error("سنوات خبرة غير صالحة.");
      await C.tx(a.userId, async (db) => {
        await db.query(
          'UPDATE sdc."DOCTOR" SET "Bio"=$1,"Years_Of_Experience"=$2 WHERE "Doctor_ID"=$3 AND "User_ID"=$4',
          [bio, experience, a.doctorId, a.userId],
        );
        await C.audit(
          db,
          a.userId,
          "doctor.profile.updated",
          "Doctor",
          a.doctorId,
          "تحديث الملف المهني",
        );
      });
      res.redirect(303, "/account/profile?saved=1");
    }),
  );
  router.get(
    "/doctor/lab-cases",
    C.route(async (req, res) => {
      const a = C.actor(req, ["doctor"]);
      const clinic = String(req.sdcSession.clinicId);
      const r = await getPool().query(
        `SELECT o."Lab_Order_ID"::text id,l."Laboratory_Name" lab,o."Order_Status" status,o."Expected_Delivery_Date"::text due,b."Booking_ID"::text booking,u."First_Name"||' '||u."Last_Name" patient FROM sdc."LAB_ORDER" o JOIN sdc."VISIT" v USING("Visit_ID") JOIN sdc."BOOKING" b USING("Booking_ID") JOIN sdc."PATIENT" p USING("Patient_ID") JOIN sdc."USER" u ON u."User_ID"=p."User_ID" JOIN sdc."LABORATORY" l USING("Laboratory_ID") WHERE b."Doctor_ID"=$1 AND b."Clinic_ID"=$2 ORDER BY o."Created_At" DESC LIMIT 250`,
        [a.doctorId, clinic],
      );
      C.page(req, res, "doctor/lab-cases", "الحالات المخبرية لمرضاي", [
        C.table("طلبات المختبر", r.rows, [
          P.col("id", "الطلب"),
          P.col("patient", "المريض"),
          P.col("lab", "المختبر"),
          P.col("status", "الحالة"),
          P.col("due", "التسليم المتوقع"),
          P.col(
            "booking",
            "الزيارة",
            (r) => "/doctor/visit?booking_id=" + r.booking,
          ),
        ]),
      ]);
    }),
  );
}
module.exports = { attach, securityData };
