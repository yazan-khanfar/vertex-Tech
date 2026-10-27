"use strict";
const express = require("express");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { col, options } = require("./patient");
const { field: F, form, table: T } = C;
async function allowed(req, db, clinic, permission) {
  const a = C.actor(req, ["admin", "doctor", "staff"]);
  if (a.role === "admin") return;
  const own = C.clinic(req, permission);
  if (String(clinic) !== own)
    throw C.error("غير مصرح لفاتورة عيادة أخرى.", 403);
  const r = await db.query("SELECT sdc.sdc_can($1,$2,$3) allowed", [
    a.userId,
    clinic,
    permission,
  ]);
  if (r.rows[0]?.allowed !== true)
    throw C.error("لا تملك صلاحية تنفيذ العملية.", 403);
}
async function createInvoice(req, b) {
  const a = C.actor(req, ["admin", "doctor", "staff"]);
  const visit = C.id(b.visit_id);
  return C.tx(
    a.userId,
    async (db) => {
      const r = await db.query(
        `SELECT v."Visit_ID",v."Visit_Status",v."Report_Approved_At",b."Clinic_ID",b."Patient_ID" FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") WHERE v."Visit_ID"=$1 FOR UPDATE OF v`,
        [visit],
      );
      if (!r.rowCount) throw C.error("الزيارة غير موجودة.", 404);
      const v = r.rows[0];
      await allowed(req, db, v.Clinic_ID, "invoices.issue");
      if (v.Visit_Status !== "completed")
        throw C.error("أكمل الزيارة قبل إنشاء الفاتورة.", 409);
      const existing = await db.query(
        'SELECT "Invoice_ID"::text id FROM sdc."INVOICE" WHERE "Visit_ID"=$1',
        [visit],
      );
      if (existing.rowCount) return { id: existing.rows[0].id };
      const lines = await db.query(
        `SELECT s."Service_Name" description,p."Quantity" quantity,p."Unit_Price_Snapshot" price FROM sdc."PROCEDURE" p JOIN sdc."SERVICE" s USING("Service_ID") WHERE p."Visit_ID"=$1 AND p."Procedure_Status"='completed' ORDER BY p."Procedure_ID"`,
        [visit],
      );
      if (!lines.rowCount)
        throw C.error("لا توجد إجراءات منفذة لإعداد الفاتورة.", 409);
      const invoice = await db.query(
        `INSERT INTO sdc."INVOICE"("Created_At","Invoice_Status","Patient_ID","Clinic_ID","Visit_ID") VALUES(LOCALTIMESTAMP,'draft',$1,$2,$3) RETURNING "Invoice_ID"::text id`,
        [v.Patient_ID, v.Clinic_ID, visit],
      );
      const id = invoice.rows[0].id;
      for (const line of lines.rows)
        await db.query(
          'INSERT INTO sdc."INVOICE_INVOICE_ITEMS"("Description","Quantity","Unit_Price","Discount_Amount","Invoice_ID") VALUES($1,$2,$3,0,$4)',
          [line.description, line.quantity, line.price, id],
        );
      await C.audit(
        db,
        a.userId,
        "invoice.draft.created",
        "Invoice",
        id,
        "إنشاء مسودة من الإجراءات المنفذة",
      );
      return { id };
    },
    { op: "invoice.create", key: b.request_key, payload: { visit } },
  );
}
async function invoiceAction(req, b) {
  const a = C.actor(req, ["admin", "doctor", "staff"]);
  const invoice = C.id(b.invoice_id),
    action = C.text(b.action, 30);
  if (!["line", "issue", "void", "payment"].includes(action))
    throw C.error("إجراء غير صالح.");
  return C.tx(
    a.userId,
    async (db) => {
      const r = await db.query(
        'SELECT * FROM sdc."INVOICE" WHERE "Invoice_ID"=$1 FOR UPDATE',
        [invoice],
      );
      if (!r.rowCount) throw C.error("الفاتورة غير موجودة.", 404);
      const bill = r.rows[0];
      await allowed(
        req,
        db,
        bill.Clinic_ID,
        action === "payment" ? "payments.record" : "invoices.issue",
      );
      if (action === "line") {
        if (bill.Invoice_Status !== "draft")
          throw C.error("لا يمكن تعديل فاتورة مصدرة أو ملغاة.", 409);
        const description = C.text(b.description, 2000),
          qty = C.money(b.quantity, { positive: true }),
          price = C.money(b.unit_price),
          discount = C.money(b.discount || "0");
        const valid = await db.query(
          "SELECT $1::numeric<=$2::numeric*$3::numeric ok",
          [discount, qty, price],
        );
        if (!valid.rows[0].ok) throw C.error("الخصم أعلى من قيمة البند.");
        if (b.item_id) {
          const changed = await db.query(
            'UPDATE sdc."INVOICE_INVOICE_ITEMS" SET "Description"=$1,"Quantity"=$2,"Unit_Price"=$3,"Discount_Amount"=$4 WHERE "Item_ID"=$5 AND "Invoice_ID"=$6',
            [description, qty, price, discount, C.id(b.item_id), invoice],
          );
          if (!changed.rowCount) throw C.error("البند غير موجود.", 404);
        } else
          await db.query(
            'INSERT INTO sdc."INVOICE_INVOICE_ITEMS"("Description","Quantity","Unit_Price","Discount_Amount","Invoice_ID") VALUES($1,$2,$3,$4,$5)',
            [description, qty, price, discount, invoice],
          );
      } else if (action === "issue") {
        if (bill.Invoice_Status !== "draft")
          throw C.error("الفاتورة ليست مسودة.", 409);
        const lines = await db.query(
          'SELECT 1 FROM sdc."INVOICE_INVOICE_ITEMS" WHERE "Invoice_ID"=$1 LIMIT 1',
          [invoice],
        );
        if (!lines.rowCount) throw C.error("أضف بنود الفاتورة أولًا.");
        await db.query(
          `UPDATE sdc."INVOICE" SET "Invoice_Status"='issued',"Issued_At"=LOCALTIMESTAMP,"Issued_By_User_ID"=$2 WHERE "Invoice_ID"=$1`,
          [invoice, a.userId],
        );
      } else if (action === "void") {
        const reason = C.text(b.reason, 2000);
        if (bill.Invoice_Status === "void")
          throw C.error("الفاتورة ملغاة بالفعل.", 409);
        const used = await db.query(
          'SELECT 1 FROM sdc."RECORDS_PAYMENT" WHERE "Invoice_ID"=$1 LIMIT 1',
          [invoice],
        );
        if (used.rowCount)
          throw C.error(
            "لا يمكن إلغاء فاتورة عليها دفعات؛ يلزم تسوية الدفعات وفق سياسة الاسترداد.",
            409,
          );
        await db.query(
          `UPDATE sdc."INVOICE" SET "Invoice_Status"='void',"Voided_At"=LOCALTIMESTAMP,"Void_Reason"=$2 WHERE "Invoice_ID"=$1`,
          [invoice, reason],
        );
      } else {
        if (bill.Invoice_Status !== "issued")
          throw C.error("لا يمكن تسجيل دفعة على فاتورة غير مصدرة.", 409);
        const amount = C.money(b.amount, { positive: true }),
          method = C.text(b.method, 30);
        if (!["cash", "card", "bank_transfer"].includes(method))
          throw C.error("طريقة دفع غير صالحة.");
        const balance = await db.query(
          'SELECT remaining_amount>=$2::numeric ok FROM sdc.invoice_balances WHERE "Invoice_ID"=$1',
          [invoice, amount],
        );
        if (!balance.rows[0].ok)
          throw C.error("الدفعة تتجاوز الرصيد المتبقي.", 409);
        await db.query(
          'INSERT INTO sdc."RECORDS_PAYMENT"("Amount","Payment_Method","Paid_At","Reference_Number","Invoice_ID","User_ID") VALUES($1,$2,LOCALTIMESTAMP,$3,$4,$5)',
          [
            amount,
            method,
            C.text(b.reference || "", 512, false) || null,
            invoice,
            a.userId,
          ],
        );
      }
      await C.audit(
        db,
        a.userId,
        "invoice." + action,
        "Invoice",
        invoice,
        "تنفيذ إجراء على الفاتورة",
      );
      const owner = await db.query(
        'SELECT "User_ID" FROM sdc."PATIENT" WHERE "Patient_ID"=$1',
        [bill.Patient_ID],
      );
      if (["issue", "payment"].includes(action))
        await C.notify(
          db,
          owner.rows[0].User_ID,
          action === "issue" ? "صدرت فاتورة جديدة" : "سُجلت دفعة على فاتورتك",
          "راجع صفحة فواتيري لمعرفة التفاصيل.",
          "Invoice",
          invoice,
        );
      return { id: invoice };
    },
    {
      op: "invoice." + action,
      key: b.request_key,
      payload: Object.fromEntries(
        Object.entries(b).filter(
          ([k]) => !["csrf_token", "request_key"].includes(k),
        ),
      ),
    },
  );
}
async function show(req, res) {
  const a = C.actor(req, ["admin", "patient", "doctor", "staff"]),
    invoice = C.id(req.query.id);
  const r = await getPool().query(
    `SELECT i.*,c."Clinic_Name" clinic,u."First_Name"||' '||u."Last_Name" patient FROM sdc.invoice_balances i JOIN sdc."CLINIC" c USING("Clinic_ID") JOIN sdc."PATIENT" p USING("Patient_ID") JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE i."Invoice_ID"=$1`,
    [invoice],
  );
  if (!r.rowCount) throw C.error("الفاتورة غير موجودة.", 404);
  const bill = r.rows[0];
  if (a.role === "patient") {
    const p = await require("./patient").profile(a.userId);
    if (
      String(p.Patient_ID) !== String(bill.Patient_ID) ||
      bill.Invoice_Status === "draft"
    )
      throw C.error("الفاتورة غير موجودة.", 404);
  } else await allowed(req, getPool(), bill.Clinic_ID, "invoices.view");
  const [lines, payments] = await Promise.all([
    getPool().query(
      'SELECT "Item_ID"::text id,"Description" description,"Quantity" quantity,"Unit_Price" price,"Discount_Amount" discount,round("Quantity"*"Unit_Price"-"Discount_Amount",2)::text total FROM sdc."INVOICE_INVOICE_ITEMS" WHERE "Invoice_ID"=$1 ORDER BY "Item_ID"',
      [invoice],
    ),
    getPool().query(
      'SELECT "Amount" amount,"Payment_Method" method,"Paid_At" at,"Reference_Number" reference FROM sdc."RECORDS_PAYMENT" WHERE "Invoice_ID"=$1 ORDER BY "Paid_At" DESC',
      [invoice],
    ),
  ]);
  const prefix = a.role === "doctor" ? "clinic" : a.role,
    action = "/" + prefix + "/billing/action";
  const sections = [
    {
      title: bill.patient + " — " + bill.clinic,
      text:
        "الحالة: " +
        bill.Invoice_Status +
        " | الإجمالي: " +
        bill.total_amount +
        " ₪ | المدفوع: " +
        bill.paid_amount +
        " ₪ | المتبقي: " +
        bill.remaining_amount +
        " ₪",
    },
    T("بنود الفاتورة", lines.rows, [
      col("description", "الوصف"),
      col("quantity", "الكمية"),
      col("price", "سعر الوحدة ₪"),
      col("discount", "الخصم ₪"),
      col("total", "الإجمالي ₪"),
    ]),
    T("سجل الدفعات", payments.rows, [
      col("amount", "المبلغ ₪"),
      col("method", "الطريقة"),
      col("at", "التاريخ"),
      col("reference", "المرجع"),
    ]),
  ];
  if (a.role !== "patient") {
    const can = async (p) => {
      try {
        await allowed(req, getPool(), bill.Clinic_ID, p);
        return true;
      } catch {
        return false;
      }
    };
    if (bill.Invoice_Status === "draft" && (await can("invoices.issue"))) {
      for (const line of [
        ...lines.rows,
        { id: "", description: "", quantity: "1", price: "0", discount: "0" },
      ])
        sections.push(
          form(
            line.id ? "تعديل بند: " + line.description : "إضافة بند",
            action,
            [
              F("description", "الوصف", line.description),
              F("quantity", "الكمية", line.quantity, "number"),
              F("unit_price", "سعر الوحدة ₪", line.price, "number"),
              F("discount", "الخصم ₪", line.discount, "number"),
            ],
            { invoice_id: invoice, action: "line", item_id: line.id },
          ),
        );
      sections.push(
        form(
          "اعتماد الفاتورة",
          action,
          [],
          { invoice_id: invoice, action: "issue" },
          "إصدار الفاتورة",
        ),
      );
    }
    if (bill.Invoice_Status === "issued" && (await can("payments.record")))
      sections.push(
        form(
          "تسجيل دفعة",
          action,
          [
            F("amount", "المبلغ ₪", "", "number"),
            F(
              "method",
              "طريقة الدفع",
              "cash",
              "select",
              options([
                ["cash", "نقدًا"],
                ["card", "بطاقة"],
                ["bank_transfer", "تحويل بنكي"],
              ]),
            ),
            { ...F("reference", "مرجع الدفع"), required: false },
          ],
          { invoice_id: invoice, action: "payment" },
        ),
      );
    if (bill.Invoice_Status !== "void" && (await can("invoices.issue")))
      sections.push(
        form(
          "إلغاء الفاتورة",
          action,
          [F("reason", "سبب الإلغاء")],
          { invoice_id: invoice, action: "void" },
          "إلغاء الفاتورة",
        ),
      );
  }
  C.page(
    req,
    res,
    prefix === "clinic"
      ? "clinic/invoices"
      : prefix === "admin"
        ? "admin/invoice-details"
        : prefix + "/invoices",
    "فاتورة رقم " + invoice,
    sections,
  );
}
function attach(router) {
  for (const prefix of ["clinic", "staff", "admin"]) {
    const body = express.urlencoded({
      extended: false,
      limit: "24kb",
      parameterLimit: 20,
    });
    router.post(
      "/" + prefix + "/billing/create",
      body,
      C.post(async (req, res) => {
        const result = await createInvoice(req, req.body);
        res.redirect(
          303,
          "/" +
            prefix +
            (prefix === "admin" ? "/invoice-details" : "/invoice") +
            "?id=" +
            result.id +
            "&saved=1",
        );
      }),
    );
    router.post(
      "/" + prefix + "/billing/action",
      body,
      C.post(async (req, res) => {
        const result = await invoiceAction(req, req.body);
        res.redirect(
          303,
          "/" +
            prefix +
            (prefix === "admin" ? "/invoice-details" : "/invoice") +
            "?id=" +
            result.id +
            "&saved=1",
        );
      }),
    );
    router.get(
      "/" + prefix + (prefix === "admin" ? "/invoice-details" : "/invoice"),
      C.route(show),
    );
  }
  router.get("/patient/invoice", C.route(show));
  for (const prefix of ["clinic", "staff"])
    router.get(
      "/" + prefix + "/billing",
      C.route(async (req, res) => {
        const clinic = C.clinic(req, "invoices.view");
        const r = await getPool().query(
          `SELECT v."Visit_ID"::text id,u."First_Name"||' '||u."Last_Name" patient,b."Appointment_Date"::text date,i."Invoice_ID"::text invoice FROM sdc."VISIT" v JOIN sdc."BOOKING" b USING("Booking_ID") JOIN sdc."PATIENT" p USING("Patient_ID") JOIN sdc."USER" u ON u."User_ID"=p."User_ID" LEFT JOIN sdc."INVOICE" i USING("Visit_ID") WHERE b."Clinic_ID"=$1 AND v."Visit_Status"='completed' ORDER BY b."Appointment_Date" DESC LIMIT 250`,
          [clinic],
        );
        const sections = [
          T("الزيارات المكتملة", r.rows, [
            col("id", "رقم الزيارة"),
            col("patient", "المريض"),
            col("date", "التاريخ"),
            col("invoice", "الفاتورة", (r) =>
              r.invoice
                ? "/" + prefix + "/invoice?id=" + r.invoice
                : "/" + prefix + "/billing",
            ),
          ]),
        ];
        try {
          await allowed(req, getPool(), clinic, "invoices.issue");
          sections.push(
            form(
              "إنشاء مسودة من إجراءات زيارة مكتملة",
              "/" + prefix + "/billing/create",
              [
                F(
                  "visit_id",
                  "اختر الزيارة المكتملة",
                  "",
                  "select",
                  r.rows.map((v) => ({
                    value: v.id,
                    label: v.patient + " — " + v.date + " — زيارة " + v.id,
                  })),
                ),
              ],
              {},
              "إعداد الفاتورة",
            ),
          );
        } catch (e) {
          if (e.status !== 403) throw e;
        }
        C.page(req, res, prefix + "/invoices", "إعداد الفواتير", sections);
      }),
    );
}
module.exports = { attach, createInvoice, invoiceAction, allowed, show };
