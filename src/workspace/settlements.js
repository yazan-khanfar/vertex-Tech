"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { col, options } = require("./patient");
async function create(req) {
  const a = C.actor(req, ["admin"]),
    b = req.body,
    clinic = C.id(b.clinic_id),
    start = C.date(b.start),
    end = C.date(b.end),
    rate = C.money(b.rate);
  if (
    start > end ||
    Date.parse(end) - Date.parse(start) > 366 * 86400000 ||
    Number(rate) > 100
  )
    throw C.error("راجع فترة التسوية ونسبة العمولة.");
  return C.tx(
    a.userId,
    async (db) => {
      const overlap = await db.query(
        'SELECT 1 FROM sdc."SETTLEMENT" WHERE "Clinic_ID"=$1 AND "Period_Start"<=$3 AND "Period_End">=$2',
        [clinic, start, end],
      );
      if (overlap.rowCount)
        throw C.error("تتداخل الفترة مع تسوية موجودة.", 409);
      const bookings = await db.query(
        `SELECT b."Booking_ID" FROM sdc."BOOKING" b JOIN sdc.booking_commissions c USING("Booking_ID") WHERE b."Clinic_ID"=$1 AND b."Appointment_Date" BETWEEN $2 AND $3 AND b."Settlement_ID" IS NULL AND c.eligible FOR UPDATE OF b`,
        [clinic, start, end],
      );
      if (!bookings.rowCount)
        throw C.error("لا توجد حجوزات مكتملة ومدفوعة بالكامل ضمن الفترة.", 409);
      const r = await db.query(
        'INSERT INTO sdc."SETTLEMENT"("Period_Start","Period_End","Created_At","Clinic_ID") VALUES($1,$2,LOCALTIMESTAMP,$3) RETURNING "Settlement_ID"::text id',
        [start, end, clinic],
      );
      const id = r.rows[0].id;
      await db.query(
        'UPDATE sdc."BOOKING" SET "Settlement_ID"=$1,"Commission_Rate_Snapshot"=$2 WHERE "Booking_ID"=ANY($3::bigint[])',
        [id, rate, bookings.rows.map((r) => r.Booking_ID)],
      );
      await C.audit(
        db,
        a.userId,
        "settlement.created",
        "Settlement",
        id,
        "إنشاء تسوية الحجوزات المدفوعة بنسبة " + rate + "%",
      );
      return { id };
    },
    {
      op: "settlement.create",
      key: b.request_key,
      payload: { clinic, start, end, rate },
    },
  );
}
function attach(router) {
  router.get(
    "/admin/settlements",
    C.route(async (req, res) => {
      C.actor(req, ["admin"]);
      const rows = await getPool().query(
        `SELECT s."Settlement_ID"::text id,c."Clinic_Name" clinic,s."Period_Start"::text start,s."Period_End"::text finish,s.total_commission total,s.paid_amount paid,s.remaining_amount remaining FROM sdc.settlement_balances s JOIN sdc."CLINIC" c USING("Clinic_ID") ORDER BY s."Settlement_ID" DESC LIMIT 250`,
      );
      const clinics = await getPool().query(
        `SELECT "Clinic_ID"::text value,"Clinic_Name" label FROM sdc."CLINIC" WHERE "Approval_Status"='approved' ORDER BY "Clinic_Name"`,
      );
      C.page(req, res, "admin/finance", "تسويات المنصة", [
        C.table("التسويات", rows.rows, [
          col("id", "التسوية"),
          col("clinic", "العيادة"),
          col("start", "من"),
          col("finish", "إلى"),
          col("total", "المستحق ₪"),
          col("paid", "المدفوع ₪"),
          col("remaining", "المتبقي ₪"),
        ]),
        C.form("إنشاء تسوية", "/admin/settlements/create", [
          C.field("clinic_id", "العيادة", "", "select", clinics.rows),
          C.field("start", "بداية الفترة", "", "date"),
          C.field("end", "نهاية الفترة", "", "date"),
          C.field("rate", "نسبة العمولة المتفق عليها %", "", "number"),
        ]),
        C.form("تسجيل سداد تسوية", "/admin/settlements/payment", [
          C.field("settlement_id", "رقم التسوية"),
          C.field("amount", "المبلغ ₪", "", "number"),
          C.field(
            "method",
            "طريقة الدفع",
            "bank_transfer",
            "select",
            options([
              ["bank_transfer", "تحويل بنكي"],
              ["cash", "نقدًا"],
              ["card", "بطاقة"],
            ]),
          ),
          C.field("reference", "مرجع الدفع"),
        ]),
      ]);
    }),
  );
  router.post(
    "/admin/settlements/create",
    express.urlencoded({ extended: false, limit: "8kb" }),
    C.post(async (req, res) => {
      await create(req);
      res.redirect(303, "/admin/settlements?saved=1");
    }),
  );
  router.post(
    "/admin/settlements/payment",
    express.urlencoded({ extended: false, limit: "8kb" }),
    C.post(async (req, res) => {
      const a = C.actor(req, ["admin"]),
        b = req.body,
        id = C.id(b.settlement_id),
        amount = C.money(b.amount, { positive: true }),
        method = C.text(b.method, 30),
        reference = C.text(b.reference, 512);
      if (!["cash", "card", "bank_transfer"].includes(method))
        throw C.error("طريقة الدفع غير صالحة.");
      await C.tx(
        a.userId,
        async (db) => {
          const r = await db.query(
            'SELECT "Settlement_ID" FROM sdc."SETTLEMENT" WHERE "Settlement_ID"=$1 FOR UPDATE',
            [id],
          );
          if (!r.rowCount) throw C.error("التسوية غير موجودة.", 404);
          const balance = await db.query(
            'SELECT remaining_amount>=$2::numeric ok FROM sdc.settlement_balances WHERE "Settlement_ID"=$1',
            [id, amount],
          );
          if (!balance.rows[0].ok)
            throw C.error("المبلغ أعلى من الرصيد المتبقي.", 409);
          await db.query(
            'INSERT INTO sdc."RECORDS_SETTLEMENT_PAYMENT"("Amount","Payment_Method","Paid_At","Reference_Number","Settlement_ID","User_ID") VALUES($1,$2,LOCALTIMESTAMP,$3,$4,$5)',
            [amount, method, reference, id, a.userId],
          );
          await C.audit(
            db,
            a.userId,
            "settlement.payment.recorded",
            "Settlement",
            id,
            "تسجيل سداد تسوية",
          );
          return { id };
        },
        {
          op: "settlement.payment",
          key: b.request_key,
          payload: { id, amount, method, reference },
        },
      );
      res.redirect(303, "/admin/settlements?saved=1");
    }),
  );
}
module.exports = { attach, create };
