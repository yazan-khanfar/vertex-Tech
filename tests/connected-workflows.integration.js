"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
if (fs.existsSync(".env")) process.loadEnvFile(".env");
if (
  !process.env.TEST_DATABASE_URL ||
  !/^vertex_.*_test$/.test(
    new URL(process.env.TEST_DATABASE_URL).pathname.slice(1),
  )
)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated vertex_*_test database initialized with schema and migrations.",
  );
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { getPool } = require("../db/pool");
const pool = getPool();
const C = require("../src/workspace/core");
const { hashPassword } = require("../src/security/password");
let server, origin;
const state = {
  tag: crypto.randomUUID().slice(0, 8),
  password: crypto.randomBytes(24).toString("hex") + "Aa1",
};
class BrowserSession {
  constructor() {
    this.cookies = new Map();
  }
  async request(path, body) {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: [...this.cookies].map(([k, v]) => k + "=" + v).join("; "),
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    for (const cookie of r.headers.getSetCookie()) {
      const [key, value] = cookie.split(";")[0].split("=");
      this.cookies.set(key, value);
    }
    return {
      status: r.status,
      location: r.headers.get("location"),
      text: await r.text(),
    };
  }
  async get(path, status = 200) {
    const r = await this.request(path);
    assert.equal(
      r.status,
      status,
      path +
        " returned " +
        r.status +
        " " +
        r.text.replace(/<[^>]*>/g, " ").slice(-350),
    );
    return r;
  }
  async submit(path, fields, status = 303) {
    const r = await this.request(path, { csrf_token: this.csrf, ...fields });
    assert.equal(
      r.status,
      status,
      path +
        " returned " +
        r.status +
        " " +
        r.text.replace(/<[^>]*>/g, " ").slice(-350),
    );
    return r;
  }
  async login(email, clinic) {
    let r = await this.get("/auth/login");
    const token = /name="csrf_token"[^>]*value="([^"]+)"/.exec(r.text)[1];
    r = await this.request("/auth/login", {
      csrf_token: token,
      email,
      password: state.password,
    });
    assert.equal(r.status, 303, "login");
    this.csrf = crypto
      .createHash("sha256")
      .update("sdc-csrf:" + this.cookies.get("sdc_session"))
      .digest("hex");
    await this.request("/auth/continue");
    if (clinic)
      await this.submit("/account/context", {
        clinic_id: clinic,
        space: "doctor",
      });
  }
}
async function user(db, role, name) {
  await db.query(
    'INSERT INTO sdc."ROLE"("Role_Name","Role_Scope") VALUES($1,\'System\') ON CONFLICT DO NOTHING',
    [role],
  );
  const email = name + "-" + state.tag + "@example.invalid";
  const r = await db.query(
    `INSERT INTO sdc."USER"("First_Name","Last_Name","Email","Phone","Password_Hash","Account_Status","Created_At","Preferred_Language","Two_Factor_Enabled","Login_Enabled","Role_ID") SELECT $1,'اختبار',$2,'0590000000',$3,'active',LOCALTIMESTAMP,'ar',false,true,"Role_ID" FROM sdc."ROLE" WHERE "Role_Name"=$4 AND "Role_Scope"='System' RETURNING "User_ID"::text id`,
    [name, email, state.hash, role],
  );
  return { id: r.rows[0].id, email };
}
before(async () => {
  state.hash = await hashPassword(state.password);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    state.admin = await user(db, "Super Admin", "admin");
    await db.query("SELECT set_config('sdc.user_id',$1,true)", [
      state.admin.id,
    ]);
    state.doctor = await user(db, "Doctor", "doctor");
    const d = await db.query(
      `INSERT INTO sdc."DOCTOR"("License_Number","License_Status","Years_Of_Experience","User_ID","License_Reviewed_By_User_ID") VALUES($1,'verified',5,$2,$3) RETURNING "Doctor_ID"::text id`,
      ["TEST-" + state.tag, state.doctor.id, state.admin.id],
    );
    state.doc = d.rows[0].id;
    const sp = await db.query(
      'INSERT INTO sdc."SPECIALTY"("Name_AR","Name_EN","Is_Active") VALUES($1,$2,true) RETURNING "Specialty_ID"::text id',
      ["تخصص " + state.tag, "Test " + state.tag],
    );
    state.specialty = sp.rows[0].id;
    await db.query(
      'INSERT INTO sdc."HAS_SPECIALTY"("Doctor_ID","Specialty_ID") VALUES($1,$2)',
      [state.doc, state.specialty],
    );
    await db.query(
      `INSERT INTO sdc."ROLE"("Role_Name","Role_Scope") VALUES('Patient','System') ON CONFLICT DO NOTHING`,
    );
    for (const label of ["clinic", "otherClinic"]) {
      const c = await db.query(
        `INSERT INTO sdc."CLINIC"("Clinic_Name","Clinic_Phone","Clinic_Email","Description","Facility_License_Number","Clinic_Status","Online_Booking_Enabled","Area","City","Address_Text","Latitude","Longitude","Approval_Status","Submitted_At","Reviewed_At","Manager_Doctor_ID","Reviewed_By_User_ID") VALUES($1,'0590000000',$2,'اختبار',$3,'active',true,'الوسط','جنين','عنوان اختبار',32.45,35.29,'approved',LOCALTIMESTAMP,LOCALTIMESTAMP,$4,$5) RETURNING "Clinic_ID"::text id`,
        [
          label + "-" + state.tag,
          label + "-" + state.tag + "@example.invalid",
          "F-" + label + state.tag,
          state.doc,
          state.admin.id,
        ],
      );
      state[label] = c.rows[0].id;
      await db.query(
        `INSERT INTO sdc."WORKS_AT"("Start_Date","Membership_Status","Clinic_ID","Doctor_ID") VALUES(CURRENT_DATE-1,'active',$1,$2)`,
        [state[label], state.doc],
      );
    }
    const svc = await db.query(
      'INSERT INTO sdc."SERVICE"("Service_Name") VALUES($1) RETURNING "Service_ID"::text id',
      ["فحص " + state.tag],
    );
    state.service = svc.rows[0].id;
    await db.query(
      'INSERT INTO sdc."OFFERS"("Price","Duration_Minutes","Allows_Installments","Is_Available","Clinic_ID","Service_ID") VALUES(100,10,true,true,$1,$2)',
      [state.clinic, state.service],
    );
    await db.query(
      'INSERT INTO sdc."PROVIDES"("Clinic_ID","Doctor_ID","Service_ID") VALUES($1,$2,$3)',
      [state.clinic, state.doc, state.service],
    );
    for (let day = 0; day < 7; day++) {
      await db.query(
        'INSERT INTO sdc."CLINIC_WORKING_HOURS"("Day_Of_Week","Start_Time","End_Time","Clinic_ID") VALUES($1,\'00:00\',\'23:59\',$2)',
        [day, state.clinic],
      );
      await db.query(
        'INSERT INTO sdc."DOCTOR_WORKING_HOURS"("Day_Of_Week","Start_Time","End_Time","Is_Active","Clinic_ID","Doctor_ID") VALUES($1,\'00:00\',\'23:59\',true,$2,$3)',
        [day, state.clinic, state.doc],
      );
    }
    state.staff = await user(db, "Staff", "staff");
    await db.query(
      `INSERT INTO sdc."ROLE"("Role_Name","Role_Scope") VALUES('Receptionist','Clinic') ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO sdc."STAFF_AT"("Membership_Status","User_ID","Clinic_ID","Role_ID") SELECT 'active',$1,$2,"Role_ID" FROM sdc."ROLE" WHERE "Role_Name"='Receptionist' AND "Role_Scope"='Clinic'`,
      [state.staff.id, state.clinic],
    );
    for (const p of [
      "appointments.view",
      "appointments.manage",
      "patients.view_admin",
      "invoices.view",
      "lab_orders.view",
    ])
      await db.query(
        'INSERT INTO sdc."STAFF_PERMISSIONS"("Permission_Code","User_ID","Clinic_ID") VALUES($1,$2,$3)',
        [p, state.staff.id, state.clinic],
      );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  server = require("../server").listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  origin = "http://127.0.0.1:" + server.address().port;
  state.manager = new BrowserSession();
  state.superadmin = new BrowserSession();
  state.worker = new BrowserSession();
  await state.manager.login(state.doctor.email, state.clinic);
  await state.superadmin.login(state.admin.email);
  await state.worker.login(state.staff.email);
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await pool.end();
});
test("patient registration, health persistence, stale-write rejection, and all patient pages", async () => {
  state.patient = new BrowserSession();
  const p = state.patient;
  const page = await p.get("/auth/register/patient");
  const token = /name="csrf_token"[^>]*value="([^"]+)"/.exec(page.text)[1];
  state.patientEmail = "patient-" + state.tag + "@example.invalid";
  const r = await p.request("/auth/register/patient", {
    csrf_token: token,
    first_name: "مريض",
    last_name: state.tag,
    email: state.patientEmail,
    phone: "0590000000",
    date_of_birth: "1995-01-01",
    gender: "male",
    password: state.password,
    confirm_password: state.password,
    accept_policies: "on",
  });
  assert.equal(r.status, 303);
  await p.login(state.patientEmail);
  state.pid = (
    await pool.query(
      'SELECT "Patient_ID"::text id FROM sdc."PATIENT" p JOIN sdc."USER" u USING("User_ID") WHERE u."Email"=$1',
      [state.patientEmail],
    )
  ).rows[0].id;
  const body = {
    profile_version: "0",
    blood: "O+",
    allergies: "Penicillin",
    chronic: "",
    medications: "",
    health_notes: "تكامل PostgreSQL",
  };
  await p.submit("/patient/health-profile", body);
  await p.submit("/patient/health-profile", body, 409);
  assert.equal(
    (
      await pool.query(
        'SELECT "Allergies" FROM sdc."PATIENT_ALLERGIES" WHERE "Patient_ID"=$1',
        [state.pid],
      )
    ).rows[0].Allergies,
    "Penicillin",
  );
  for (const path of [
    "/patient/index",
    "/patient/profile",
    "/patient/security",
    "/patient/invoices",
    "/patient/notifications",
    "/patient/diagnosis-history",
    "/patient/ai-diagnosis",
    "/patient/clinics",
    "/patient/doctors",
  ])
    await p.get(path);
  await p
    .request("/patient/health-profile", { ...body, csrf_token: "bad" })
    .then((r) => assert.equal(r.status, 403));
});
test("real booking, clinic confirmation/check-in, browser starts visit, clinical procedure and completion", async () => {
  assert(state.patient);
  const svc = require("../src/appointments/service");
  const today = svc.localNow().date;
  state.date = today;
  const choice = (await svc.catalog(pool, state.clinic)).find(
    (x) => x.service_id === state.service,
  );
  const slots = await svc.slots(pool, choice, today, state.pid);
  assert(
    slots.length,
    "A future slot today is needed for the check-in workflow",
  );
  const r = await state.patient.submit("/patient/book-appointment", {
    clinic_id: state.clinic,
    doctor_id: state.doc,
    service_id: state.service,
    appointment_date: today,
    appointment_time: slots[0],
  });
  state.booking = new URL(r.location, origin).searchParams.get("id");
  assert(state.booking);
  await state.manager.submit("/clinic/appointments/action", {
    booking_id: state.booking,
    action: "confirm",
  });
  await state.worker.submit("/staff/operations/action", {
    booking_id: state.booking,
    action: "check_in",
  });
  // Advance the clinical fixture to after its booked slot; the database deliberately rejects report approval before scheduled time.
  await C.tx(state.admin.id, async (db) => {
    await db.query(
      "UPDATE sdc.\"BOOKING\" SET \"Start_Time\"=GREATEST(TIME '00:00',(now() AT TIME ZONE 'Asia/Hebron')::time-INTERVAL '30 minutes') WHERE \"Booking_ID\"=$1",
      [state.booking],
    );
  });

  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.SDC_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: "/workspace/.onboarding/vertex-tech/xdg-config",
      XDG_CACHE_HOME: "/workspace/.onboarding/vertex-tech/xdg-cache",
    },
  });
  try {
    const context = await browser.newContext();
    await context.addCookies(
      [...state.manager.cookies].map(([name, value]) => ({
        name,
        value,
        url: origin,
      })),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/doctor/visit?booking_id=" + state.booking);
    await page.locator("#chiefComplaint").fill("ألم الأسنان");
    await Promise.all([
      page.waitForURL(/saved=1/),
      page.locator("#saveVisitDraft").click(),
    ]);
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    await browser.close();
  }
  state.visit = (
    await pool.query(
      'SELECT "Visit_ID"::text id FROM sdc."VISIT" WHERE "Booking_ID"=$1',
      [state.booking],
    )
  ).rows[0].id;
  await state.manager.submit("/doctor/visit/clinical/action", {
    booking_id: state.booking,
    action: "procedure",
    service_id: state.service,
    quantity: "1",
    procedure_status: "completed",
  });
  await state.manager.submit("/doctor/visit/action", {
    booking_id: state.booking,
    action: "complete",
    chief_complaint: "ألم الأسنان",
    examination_notes: "فحص اختبار موثق",
  });
  await state.manager.get("/doctor/visit?booking_id=" + state.booking);
  await state.manager.submit("/doctor/visit/report/approve", {
    booking_id: state.booking,
  });
  const report = await state.patient.get(
    "/patient/report/file?id=" + state.visit,
  );
  assert(report.text.startsWith("%PDF-"));
  await state.manager.submit(
    "/doctor/visit/clinical/action",
    {
      booking_id: state.booking,
      action: "procedure",
      service_id: state.service,
      quantity: "1",
      procedure_status: "completed",
    },
    409,
  );
});
test("invoice lifecycle, concurrent duplicate payments, overpayment and ownership protection", async () => {
  assert(state.visit);
  const r = await state.manager.submit("/clinic/billing/create", {
    visit_id: state.visit,
    request_key: crypto.randomUUID(),
  });
  state.invoice = new URL(r.location, origin).searchParams.get("id");
  await state.manager.get("/clinic/invoice?id=" + state.invoice);
  await state.manager.submit("/clinic/billing/action", {
    invoice_id: state.invoice,
    action: "issue",
    request_key: crypto.randomUUID(),
  });
  const payload = {
    invoice_id: state.invoice,
    action: "payment",
    amount: "100",
    method: "cash",
    request_key: crypto.randomUUID(),
  };
  await Promise.all([
    state.manager.submit("/clinic/billing/action", payload),
    state.manager.submit("/clinic/billing/action", payload),
  ]);
  assert.equal(
    (
      await pool.query(
        'SELECT COUNT(*)::int n FROM sdc."RECORDS_PAYMENT" WHERE "Invoice_ID"=$1',
        [state.invoice],
      )
    ).rows[0].n,
    1,
  );
  await state.manager.submit(
    "/clinic/billing/action",
    { ...payload, amount: "1", request_key: crypto.randomUUID() },
    409,
  );
  await state.worker.submit(
    "/staff/billing/action",
    { ...payload, request_key: crypto.randomUUID() },
    403,
  );
  await state.patient.get("/patient/invoice?id=" + state.invoice);
  await state.worker.get("/staff/invoice?id=" + state.invoice);
  const other = new BrowserSession();
  await other.login(state.doctor.email, state.otherClinic);
  await other.get("/clinic/invoice?id=" + state.invoice, 403);
  await state.patient.get("/patient/invoice?id=999999999999", 404);
});
test("catalog writes, settlement creation/payment, and all newly connected administration screens", async () => {
  assert(state.invoice);
  await state.superadmin.submit("/admin/catalog/services", {
    Service_Name: "خدمة جديدة " + state.tag,
  });
  await state.superadmin.submit("/admin/settlements/create", {
    clinic_id: state.clinic,
    start: state.date,
    end: state.date,
    rate: "10",
    request_key: crypto.randomUUID(),
  });
  const settlement = (
    await pool.query(
      'SELECT "Settlement_ID"::text id FROM sdc."SETTLEMENT" WHERE "Clinic_ID"=$1',
      [state.clinic],
    )
  ).rows[0].id;
  await state.superadmin.submit("/admin/settlements/payment", {
    settlement_id: settlement,
    amount: "10",
    method: "bank_transfer",
    reference: "test-" + state.tag,
    request_key: crypto.randomUUID(),
  });
  for (const path of [
    "index",
    "management-center",
    "users",
    "finance",
    "reports",
    "services",
    "specialties",
    "labs",
    "staff-permissions",
    "settings",
    "settlements",
    "approvals",
    "doctors",
    "system-log",
  ])
    await state.superadmin.get("/admin/" + path);
  for (const path of [
    "/admin/user-details?id=" + state.staff.id,
    "/admin/doctor-details?id=" + state.doc,
    "/admin/appointment-details?id=" + state.booking,
    "/admin/medical-record-details?id=" + state.visit,
    "/admin/invoice-details?id=" + state.invoice,
    "/admin/clinic-details?id=" + state.clinic,
    "/admin/clinic-application-details?id=" + state.clinic,
    "/admin/doctor-license-review?id=" + state.doc,
  ])
    await state.superadmin.get(path);
  for (const path of [
    "/staff/index",
    "/staff/patients",
    "/staff/invoices",
    "/staff/lab-cases",
    "/staff/profile",
    "/staff/billing",
    "/doctor/settings",
    "/doctor/lab-cases",
    "/clinic/billing",
    "/clinic/settlements",
  ])
    await (path.startsWith("/staff") ? state.worker : state.manager).get(path);
});
test("doctor job application is persisted, visible to clinic and can be withdrawn", async () => {
  const job = await C.tx(
    state.admin.id,
    async (db) =>
      (
        await db.query(
          `INSERT INTO sdc."JOB"("Job_Title","Employment_Type","Minimum_Experience_Years","Application_Deadline","Work_Schedule_Description","Salary_Description","Summary","Responsibilities","Requirements","Job_Status","Clinic_ID","Specialty_ID") VALUES('وظيفة اختبار','full_time',1,CURRENT_DATE+5,'دوام كامل','حسب الاتفاق','اختبار','مهام','متطلبات','open',$1,$2) RETURNING "Job_ID"::text id`,
          [state.clinic, state.specialty],
        )
      ).rows[0].id,
  );
  state.job = job;
  await state.manager.get("/onboarding/doctor/jobs/index");
  await state.manager.get("/onboarding/doctor/jobs/details?job=" + job);
  const r = await state.manager.submit("/onboarding/doctor/jobs/apply", {
    job_id: job,
    city: "جنين",
    cover: "تقديم اختبار",
    consent: "on",
    request_key: crypto.randomUUID(),
  });
  const id = new URL(r.location, origin).searchParams.get("application");
  assert(id);
  state.application = id;
  await state.manager.get(
    "/onboarding/doctor/jobs/application-preview?application=" + id,
  );
  await state.manager.get("/clinic/application-details?id=" + id);
  await state.superadmin.get("/admin/job-details?id=" + job);
  await state.superadmin.get("/admin/job-application-details?id=" + id);
  await state.manager.submit("/onboarding/doctor/jobs/withdraw", {
    application_id: id,
  });
  assert.equal(
    (
      await pool.query(
        'SELECT "Application_Status" status FROM sdc."APPLIES_FOR" WHERE "Application_ID"=$1',
        [id],
      )
    ).rows[0].status,
    "withdrawn",
  );
});
test("AI adapter validates provider output, preserves TLS, and fails closed without configuration", async () => {
  const saved = Object.fromEntries(
    ["AI_API_URL", "AI_MODEL", "AI_PROVIDER_KEY"].map((k) => [
      k,
      process.env[k],
    ]),
  );
  try {
    process.env.AI_API_URL = "https://api.example.invalid/v1/chat/completions";
    process.env.AI_MODEL = "test-model";
    process.env.AI_PROVIDER_KEY = "test-placeholder";
    const { assess } = require("../src/workspace/ai");
    const out = await assess("ألم أسنان", async (url, init) => {
      assert.equal(url, process.env.AI_API_URL);
      assert.equal(init.headers.Authorization, "Bearer test-placeholder");
      const body = JSON.parse(init.body);
      assert.equal(body.messages[1].content, "ألم أسنان");
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "تقييم أولي",
                    risk: "moderate",
                    advice: "راجع طبيب الأسنان للفحص.",
                  }),
                },
              },
            ],
          }),
      };
    });
    assert.equal(out.risk, "moderate");
    await assert.rejects(
      () =>
        assess("ألم", async () => ({
          ok: true,
          text: async () => '{"bad":true}',
        })),
      { status: 502 },
    );
    delete process.env.AI_PROVIDER_KEY;
    await assert.rejects(() => assess("ألم"), { status: 503 });
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
test("every role page loads real scoped records or its documented canonical redirect", async () => {
  await state.superadmin.submit("/admin/catalog/labs", {
    Laboratory_Name: "مختبر " + state.tag,
    Phone: "0590000000",
    Address: "جنين",
    Additional_Contact: "",
  });
  state.lab = (
    await pool.query(
      'SELECT "Laboratory_ID"::text id FROM sdc."LABORATORY" WHERE "Laboratory_Name"=$1',
      ["مختبر " + state.tag],
    )
  ).rows[0].id;
  await state.manager.submit("/clinic/lab-cases/link", {
    laboratory_id: state.lab,
    internal_notes: "",
  });
  const created = await state.manager.submit("/doctor/treatment-plans/create", {
    new_plan_patient: state.pid,
    new_plan_name: "خطة " + state.tag,
    new_plan_first_step: "فحص ومتابعة",
    new_plan_status: "active",
  });
  state.plan = new URL(created.location, origin).searchParams.get("id");
  const overrides = {
    "admin/appointment-details": "id=" + state.booking,
    "admin/clinic-application-details": "id=" + state.clinic,
    "admin/clinic-details": "id=" + state.clinic,
    "admin/doctor-details": "id=" + state.doc,
    "admin/doctor-license-review": "id=" + state.doc,
    "admin/invoice-details": "id=" + state.invoice,
    "admin/job-application-details": "id=" + state.application,
    "admin/job-details": "id=" + state.job,
    "admin/lab-details": "id=" + state.lab,
    "admin/medical-record-details": "id=" + state.visit,
    "admin/user-details": "id=" + state.staff.id,
    "clinic/application-details": "id=" + state.application,
    "clinic/appointment-details": "id=" + state.booking,
    "clinic/doctor-details": "id=" + state.doc,
    "clinic/doctor-report": "visit_id=" + state.visit,
    "clinic/lab-details": "lab=" + state.lab,
    "clinic/patient-details": "id=" + state.pid,
    "clinic/treatment-plan-details": "id=" + state.plan,
    "clinic/visit-checkout": "visit_id=" + state.visit,
    "doctor/patient-details": "id=" + state.pid,
    "doctor/report-current-visit": "booking_id=" + state.booking,
    "doctor/report-details": "id=" + state.visit,
    "doctor/treatment-plan-details": "id=" + state.plan,
    "doctor/visit": "booking_id=" + state.booking,
    "staff/lab-details": "lab=" + state.lab,
    "patient/appointment-details": "id=" + state.booking,
    "patient/booking-details": "id=" + state.booking,
    "patient/clinic-details": "clinic_id=" + state.clinic,
    "patient/doctor-details":
      "doctor_id=" + state.doc + "&clinic_id=" + state.clinic,
    "onboarding/doctor/jobs/details": "job=" + state.job,
    "onboarding/doctor/jobs/application-preview":
      "application=" + state.application,
    "onboarding/doctor/jobs/application-status":
      "application=" + state.application,
  };
  const redirects = new Set([
    "doctor/report-current-visit",
    "doctor/report-details",
    "patient/appointment-details",
    "onboarding/doctor/clinic/create",
  ]);
  let checked = 0;
  for (const key of Object.keys(require("../config/page-map.json"))) {
    const slug = key.replace(/\.html$/, "");
    const role = slug.split("/")[0],
      session = {
        admin: state.superadmin,
        clinic: state.manager,
        doctor: state.manager,
        staff: state.worker,
        patient: state.patient,
        onboarding: state.manager,
      }[role];
    if (!session) continue;
    const r = await session.request(
      "/" + slug + (overrides[slug] ? "?" + overrides[slug] : ""),
    );
    assert(
      redirects.has(slug) ? [200, 303].includes(r.status) : r.status === 200,
      slug +
        " returned " +
        r.status +
        " " +
        r.text.replace(/<[^>]*>/g, " ").slice(-250),
    );
    checked++;
  }
  assert.equal(checked, 99); // All pages in the six authenticated/onboarding groups.
});
test("live doctor registration uses the specialty catalog and clinic onboarding persists private documents and approval", async () => {
  const applicant = new BrowserSession(),
    email = "new-doctor-" + state.tag + "@example.invalid";
  const registration = await applicant.get("/auth/register/doctor");
  assert(registration.text.includes('value="' + state.specialty + '"'));
  const csrf = /name="csrf_token"[^>]*value="([^"]+)"/.exec(
    registration.text,
  )[1];
  const created = await applicant.request("/auth/register/doctor", {
    csrf_token: csrf,
    first_name: "طبيب",
    last_name: "اختبار",
    phone: "0591234567",
    email,
    license_number: "NEW-" + state.tag,
    password: state.password,
    confirm_password: state.password,
    accept_policies: "on",
    "specialty_ids[]": state.specialty,
  });
  assert.equal(created.status, 303);
  const doc = (
    await pool.query(
      'SELECT d."Doctor_ID"::text id,u."Account_Status" status FROM sdc."DOCTOR" d JOIN sdc."USER" u USING("User_ID") WHERE u."Email"=$1',
      [email],
    )
  ).rows[0];
  assert.equal(doc.status, "pending");
  await state.superadmin.get("/admin/doctor-license-review?id=" + doc.id);
  await state.superadmin.submit("/admin/doctor-license-review", {
    csrf_token: state.superadmin.cookies.get("sdc_admin_csrf").split(".")[0],
    doctor_id: doc.id,
    decision: "approve",
    reason: "تم التحقق من وثائق الطبيب للاختبار",
    number_valid: "on",
    identity_matches: "on",
    specialty_matches: "on",
  });
  await applicant.login(email);
  await applicant.get("/doctor/profile");
  await applicant.get("/account/profile");
  await applicant.get("/onboarding/doctor/clinic/create");
  const form = new FormData();
  for (const [k, v] of Object.entries({
    csrf_token: applicant.csrf,
    clinic_name: "عيادة تقديم " + state.tag,
    city: "جنين",
    area: "الوسط",
    phone: "0591234567",
    email: "submitted-clinic-" + state.tag + "@example.invalid",
    address: "عنوان تجريبي",
    facility_license_number: "SUB-" + state.tag,
    latitude: "32.45",
    longitude: "35.29",
    notes: "طلب اختبار",
  }))
    form.set(k, v);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScYvZwAAAABJRU5ErkJggg==",
    "base64",
  );
  for (const name of ["license", "manager"])
    form.set(name, new Blob([png], { type: "image/png" }), name + ".png");
  const response = await fetch(origin + "/onboarding/doctor/clinic/create", {
    method: "POST",
    headers: {
      Cookie: [...applicant.cookies].map(([k, v]) => k + "=" + v).join("; "),
    },
    body: form,
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  const clinic = new URL(
    response.headers.get("location"),
    origin,
  ).searchParams.get("id");
  assert(clinic);
  await applicant.get(
    "/onboarding/doctor/clinic/application-status?id=" + clinic,
  );
  const docs = (
    await pool.query(
      'SELECT "Document_ID"::text id,"File_Reference" ref FROM sdc."CLINIC_DOCUMENTS" WHERE "Clinic_ID"=$1',
      [clinic],
    )
  ).rows;
  assert.equal(docs.length, 2);
  for (const d of docs) {
    assert(
      fs.existsSync(
        require("../src/clinic-onboarding/service").documentPath(d.ref),
      ),
    );
    await state.superadmin.get("/admin/clinic-document/" + d.id);
  }
  await state.superadmin.get("/admin/clinic-application-details?id=" + clinic);
  await state.superadmin.submit("/admin/clinic-application-details", {
    csrf_token: state.superadmin.cookies.get("sdc_admin_csrf").split(".")[0],
    clinic_id: clinic,
    decision: "approve",
    reason: "تم التحقق من بيانات ومستندات العيادة للاختبار",
    details: "on",
    contact: "on",
    license: "on",
    manager: "on",
  });
  await applicant.request("/auth/continue");
  await applicant.get("/clinic/index");
  assert.equal(
    (
      await pool.query(
        'SELECT "Approval_Status" status FROM sdc."CLINIC" WHERE "Clinic_ID"=$1',
        [clinic],
      )
    ).rows[0].status,
    "approved",
  );
});
test("support requests persist, admin replies notify the owner, and other users cannot read them", async () => {
  await state.patient.get("/account/support");
  await state.patient.submit("/account/support/create", {
    subject: "مشكلة تقنية " + state.tag,
    message: "اختبار حفظ طلب الدعم",
    request_key: crypto.randomUUID(),
  });
  const ticket = (
    await pool.query(
      'SELECT "Ticket_ID"::text id FROM sdc."SUPPORT_TICKETS" WHERE "Subject"=$1',
      ["مشكلة تقنية " + state.tag],
    )
  ).rows[0].id;
  const hidden = await state.manager.get("/account/support");
  assert(!hidden.text.includes("مشكلة تقنية " + state.tag));
  await state.superadmin.submit("/account/support/reply", {
    ticket_id: ticket,
    reply: "تمت مراجعة طلب الاختبار",
    status: "replied",
    request_key: crypto.randomUUID(),
  });
  const page = await state.patient.get("/account/support");
  assert(page.text.includes("تمت مراجعة طلب الاختبار"));
  await state.worker.submit(
    "/account/support/reply",
    {
      ticket_id: ticket,
      reply: "غير مسموح",
      status: "closed",
      request_key: crypto.randomUUID(),
    },
    403,
  );
});
test("connected views run without browser exceptions and the patient health form saves through its actual button", async () => {
  const { chromium } = require("playwright-core"),
    path = require("node:path");
  const browser = await chromium.launch({
    executablePath: process.env.SDC_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.resolve(".local/xdg-config"),
      XDG_CACHE_HOME: path.resolve(".local/xdg-cache"),
    },
  });
  try {
    for (const [session, paths] of [
      [new BrowserSession(), ["/auth/register/doctor"]],
      [
        state.patient,
        [
          "/patient/index",
          "/patient/profile",
          "/patient/invoices",
          "/account/support",
        ],
      ],
      [state.worker, ["/staff/index", "/staff/profile"]],
      [state.superadmin, ["/admin/index", "/admin/settings"]],
      [
        state.manager,
        [
          "/doctor/profile",
          "/doctor/settings",
          "/onboarding/doctor/jobs/details?job=" + state.job,
        ],
      ],
    ]) {
      const context = await browser.newContext();
      await context.addCookies(
        [...session.cookies].map(([name, value]) => ({
          name,
          value,
          url: origin,
        })),
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      for (const route of paths) {
        await page.goto(origin + route);
        await page.waitForLoadState("load");
        assert.equal(errors.length, 0, route + ": " + errors.join("\n"));
      }
      if (session === state.patient) {
        await page.goto(origin + "/patient/profile");
        await page
          .locator('textarea[name="health_notes"]')
          .fill("حُفظ من زر النموذج في المتصفح");
        await Promise.all([
          page.waitForURL(/saved=1/),
          page
            .locator(
              'form[action="/patient/health-profile"] button[type="submit"]',
            )
            .click(),
        ]);
        assert.equal(
          (
            await pool.query(
              'SELECT "Health_Notes" notes FROM sdc."PATIENT" WHERE "Patient_ID"=$1',
              [state.pid],
            )
          ).rows[0].notes,
          "حُفظ من زر النموذج في المتصفح",
        );
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
