"use strict";
const crypto = require("node:crypto");
const { getPool } = require("../../db/pool");
const { sessionCsrf, validateSessionCsrf } = require("../auth/session");
const pages = require("../../config/page-map.json");
function error(message, status = 422) {
  return Object.assign(new Error(message), { status });
}
function text(v, max = 150, required = true) {
  if (typeof v !== "string" || v.length > max * 2)
    throw error("تحقق من النص المدخل.");
  const s = v.trim();
  if (s.length > max || (required && !s))
    throw error("أكمل الحقول المطلوبة ضمن الطول المسموح.");
  return s;
}
function id(v) {
  if (!/^[1-9]\d{0,17}$/.test(String(v || ""))) throw error("معرّف غير صالح.");
  return String(v);
}
function date(v) {
  const s = String(v || "");
  if (
    !/^\d{4}-\d\d-\d\d$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s + "T12:00:00Z").toISOString().slice(0, 10) !== s
  )
    throw error("تاريخ غير صالح.");
  return s;
}
function money(v, { positive = false } = {}) {
  const s = String(v ?? "");
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(s) || (positive && Number(s) <= 0))
    throw error("مبلغ غير صالح.");
  return s;
}
function cents(v) {
  const [a, b = ""] = money(v).split(".");
  return BigInt(a) * 100n + BigInt((b + "00").slice(0, 2));
}
function clinic(req, permission) {
  const c = req.sdcClinics?.find(
    (c) => c.id === String(req.sdcSession?.clinicId),
  );
  if (!c) throw error("اختر عيادة فعالة.", 403);
  if (req.sdcActor.role === "doctor" && !c.manager)
    throw error("هذه العملية لإدارة العيادة.", 403);
  if (
    req.sdcActor.role === "staff" &&
    permission &&
    !require("../staff-access/policy").can(
      req.res.locals.staffPermissions,
      permission,
    )
  )
    throw error("لا تملك صلاحية تنفيذ العملية.", 403);
  return c.id;
}
function actor(req, roles) {
  if (!req.sdcActor || (roles && !roles.includes(req.sdcActor.role)))
    throw error("غير مصرح.", 403);
  return req.sdcActor;
}
async function tx(user, fn, receipt) {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(534443,570406)");
    await db.query("SELECT set_config('sdc.user_id',$1,true)", [String(user)]);
    let hash;
    if (receipt) {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          receipt.key || "",
        )
      )
        throw error("حدّث الصفحة قبل إعادة العملية.");
      hash = crypto
        .createHash("sha256")
        .update(JSON.stringify(receipt.payload))
        .digest("hex");
      const old = await db.query(
        'SELECT "Operation","Payload_Hash","Result" FROM sdc."ACTION_RECEIPTS" WHERE "Actor_ID"=$1 AND "Request_Key"=$2',
        [user, receipt.key],
      );
      if (old.rowCount) {
        const r = old.rows[0];
        if (r.Operation !== receipt.op || r.Payload_Hash !== hash)
          throw error("استُخدم رمز العملية لطلب مختلف.", 409);
        await db.query("COMMIT");
        return r.Result;
      }
    }
    const result = await fn(db);
    if (receipt)
      await db.query(
        'INSERT INTO sdc."ACTION_RECEIPTS"("Actor_ID","Request_Key","Operation","Payload_Hash","Result") VALUES($1,$2,$3,$4,$5)',
        [user, receipt.key, receipt.op, hash, JSON.stringify(result ?? {})],
      );
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
async function audit(db, user, action, target, reference, description) {
  await db.query(
    'INSERT INTO sdc."AUDIT_LOG"("Occurred_At","Action_Type","Target_Type","Target_Reference","Description","User_ID") VALUES(LOCALTIMESTAMP,$1,$2,$3,$4,$5)',
    [action, target, String(reference), description, user],
  );
}
async function notify(db, user, title, body, target = null, reference = null) {
  await db.query(
    'INSERT INTO sdc."NOTIFICATION"("Title","Body","Notification_Type","Created_At","Target_Type","Target_Reference","User_ID") VALUES($1,$2,\'workflow\',LOCALTIMESTAMP,$3,$4,$5)',
    [title, body, target, reference == null ? null : String(reference), user],
  );
}
function route(fn) {
  return (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((e) => {
        const status =
          e.status ||
          { 23505: 409, 23503: 409, 23514: 409, 42501: 403 }[e.code] ||
          500;
        if (status === 500)
          console.error("[WORKSPACE]", req.path, e.code || e.message);
        res.status(status).render("shared/error", {
          message: e.status
            ? e.message
            : status === 409
              ? "تعارضت العملية مع سجل أو حالة موجودة. حدّث الصفحة وتحقق من البيانات."
              : "تعذّر إكمال العملية. حاول مجددًا.",
          back: req.path,
        });
      });
}
function post(fn) {
  return route(async (req, res) => {
    if (!validateSessionCsrf(req))
      throw error("انتهت صلاحية النموذج؛ حدّث الصفحة.", 403);
    return fn(req, res);
  });
}
function displayValue(value, key) {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date)
    return value.toLocaleString("ar", { timeZone: "Asia/Hebron" });
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  const labels = {
    active: "نشط",
    pending: "قيد المراجعة",
    suspended: "موقوف",
    disabled: "معطل",
    inactive: "غير نشط",
    approved: "معتمد",
    verified: "موثق",
    rejected: "مرفوض",
    draft: "مسودة",
    issued: "مصدر",
    void: "ملغى",
    completed: "مكتمل",
    in_progress: "جارٍ",
    confirmed: "مؤكد",
    cancelled: "ملغى",
    no_show: "لم يحضر",
    accepted: "مقبول",
    withdrawn: "مسحوب",
    sent: "مرسل",
    received: "مستلم",
    open: "مفتوح",
    closed: "مغلق",
    replied: "تم الرد",
    cash: "نقدًا",
    card: "بطاقة",
    bank_transfer: "تحويل بنكي",
    low: "منخفض",
    moderate: "متوسط",
    high: "مرتفع",
    urgent: "عاجل",
  };
  return [
    "status",
    "approval",
    "method",
    "risk",
    "Order_Status",
    "Membership_Status",
    "Relationship_Status",
  ].includes(key) && Object.hasOwn(labels, value)
    ? labels[value]
    : String(value);
}
function page(req, res, slug, title, sections = [], extra = {}) {
  const item = pages[slug + ".html"];
  if (!item) throw error("صفحة غير موجودة.", 404);
  const role = item.role;
  const layoutRole = role === "onboarding" ? "home" : role;
  const css = (k, h) =>
    item[k + "ActiveClasses"][h] ? " " + item[k + "ActiveClasses"][h] : "";
  res.set("Cache-Control", "private, no-store");
  return res.render("shared/data-page", {
    ...item,
    currentPage: slug + ".html",
    role,
    layoutRole,
    title,
    sections,
    displayValue,
    csrfToken: sessionCsrf(req),
    requestKey: crypto.randomUUID(),
    currentUser: res.locals.currentUser || req.sdcActor,
    activeClinic: res.locals.activeClinic || null,
    logoutCsrf: res.locals.logoutCsrf || "",
    staffPermissions: res.locals.staffPermissions || "",
    staffClinicRole: res.locals.staffClinicRole || "",
    hasStaffPermission: (c) =>
      require("../staff-access/policy").can(res.locals.staffPermissions, c),
    pendingClinicCount: res.locals.adminPendingClinics || 0,
    adminCsrfToken: "",
    navActiveClass: (h) => css("nav", h),
    navAriaCurrent: (h) =>
      item.navAria[h] === "page" ? ' aria-current="page"' : "",
    drawerActiveClass: (h) => css("drawer", h),
    drawerAriaCurrent: (h) =>
      item.drawerAria[h] === "page" ? ' aria-current="page"' : "",
    saved: req.query.saved === "1",
    ...extra,
  });
}
const field = (name, label, value = "", type = "text", options) => ({
  name,
  label,
  value: value ?? "",
  type,
  options,
});
const form = (title, action, fields, hidden = {}, submit = "حفظ") => ({
  title,
  form: { action, fields, hidden, submit },
});
const table = (title, rows, columns) => ({ title, rows, columns });
module.exports = {
  error,
  text,
  id,
  date,
  money,
  cents,
  clinic,
  actor,
  tx,
  audit,
  notify,
  route,
  post,
  page,
  field,
  form,
  table,
};
