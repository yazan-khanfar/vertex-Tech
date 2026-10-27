"use strict";
const express = require("express"),
  multer = require("multer"),
  crypto = require("node:crypto"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const { getPool } = require("../../db/pool");
const C = require("./core");
const { col } = require("./patient");
const docs = require("../clinic-onboarding/service");
const base = "/onboarding/doctor/jobs";
function doctor(req) {
  return C.actor(req, ["doctor"]);
}
async function jobs(db, job) {
  return db.query(
    `SELECT j.*,c."Clinic_Name",c."City",s."Name_AR" FROM sdc."JOB" j JOIN sdc."CLINIC" c USING("Clinic_ID") JOIN sdc."SPECIALTY" s USING("Specialty_ID") WHERE j."Job_Status"='open' AND j."Application_Deadline">=(now() AT TIME ZONE 'Asia/Hebron')::date AND c."Clinic_Status"='active' AND c."Approval_Status"='approved' AND ($1::bigint IS NULL OR j."Job_ID"=$1) ORDER BY j."Job_ID" DESC LIMIT 200`,
    [job || null],
  );
}
async function apply(req) {
  const a = doctor(req),
    b = req.body,
    job = C.id(b.job_id),
    city = C.text(b.city),
    cover = C.text(b.cover || "", 5000, false),
    salary = b.salary ? C.money(b.salary) : null;
  if (b.consent !== "on")
    throw C.error("الموافقة على مشاركة بيانات الطلب مطلوبة.");
  const files = req.files || [];
  const checked = files.map((f) => {
    const type = docs.docType(f.buffer);
    if (!type) throw C.error("المرفقات المسموحة PDF وPNG وJPG.");
    return { file: f, type };
  });
  const written = [];
  try {
    return await C.tx(
      a.userId,
      async (db) => {
        const found = await jobs(db, job);
        if (!found.rowCount) throw C.error("الوظيفة مغلقة أو غير متاحة.", 409);
        const j = found.rows[0];
        const own = await db.query(
          `SELECT u."First_Name"||' '||u."Last_Name" name,u."Email",u."Phone",d."License_Number",d."License_Status",COALESCE(d."Years_Of_Experience",0) experience FROM sdc."USER" u JOIN sdc."DOCTOR" d USING("User_ID") WHERE d."Doctor_ID"=$1 AND u."User_ID"=$2`,
          [a.doctorId, a.userId],
        );
        const d = own.rows[0];
        if (d.License_Status !== "verified")
          throw C.error("يجب اعتماد الترخيص أولًا.", 403);
        const specialty = await db.query(
          `SELECT s."Name_AR" FROM sdc."HAS_SPECIALTY" h JOIN sdc."SPECIALTY" s USING("Specialty_ID") WHERE h."Doctor_ID"=$1 AND s."Specialty_ID"=$2 AND s."Is_Active"`,
          [a.doctorId, j.Specialty_ID],
        );
        if (!specialty.rowCount || d.experience < j.Minimum_Experience_Years)
          throw C.error("تخصصك أو خبرتك المسجلة لا يطابقان متطلبات الوظيفة.");
        const r = await db.query(
          `INSERT INTO sdc."APPLIES_FOR"("Application_Status","Applied_At","Expected_Salary","Cover_Letter","Sharing_Consent_At","Full_Name","Email","Phone","Residence_City","Specialty_Name","License_Number","License_Status","Years_Of_Experience","Doctor_ID","Job_ID") VALUES('pending',LOCALTIMESTAMP,$1,$2,LOCALTIMESTAMP,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING "Application_ID"::text id`,
          [
            salary,
            cover || null,
            d.name,
            d.Email,
            d.Phone,
            city,
            specialty.rows[0].Name_AR,
            d.License_Number,
            d.License_Status,
            d.experience,
            a.doctorId,
            job,
          ],
        );
        const id = r.rows[0].id;
        for (const { file, type } of checked) {
          const ref = crypto.randomUUID() + type.extension,
            dest = docs.documentPath(ref);
          await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          await fs.writeFile(dest, file.buffer, { flag: "wx", mode: 0o600 });
          written.push(dest);
          await db.query(
            `INSERT INTO sdc."JOB_APPLICATION_ATTACHMENTS"("Attachment_Type","File_Name","File_Reference","Uploaded_At","Application_ID") VALUES('supporting_document',$1,$2,LOCALTIMESTAMP,$3)`,
            [
              path
                .basename(file.originalname)
                .replace(/[\x00-\x1f]/g, "")
                .slice(0, 180),
              ref,
              id,
            ],
          );
        }
        await C.audit(
          db,
          a.userId,
          "job.application.created",
          "Application",
          id,
          "تقديم طلب توظيف مع موافقة المشاركة",
        );
        const manager = await db.query(
          'SELECT "User_ID" FROM sdc."DOCTOR" WHERE "Doctor_ID"=(SELECT "Manager_Doctor_ID" FROM sdc."CLINIC" WHERE "Clinic_ID"=$1)',
          [j.Clinic_ID],
        );
        await C.notify(
          db,
          manager.rows[0].User_ID,
          "طلب توظيف جديد",
          "وصل طلب توظيف جديد إلى العيادة.",
          "Application",
          id,
        );
        return { id };
      },
      {
        op: "job.apply",
        key: b.request_key,
        payload: {
          job,
          city,
          cover,
          salary,
          files: checked.map((f) =>
            crypto.createHash("sha256").update(f.file.buffer).digest("hex"),
          ),
        },
      },
    );
  } catch (e) {
    await Promise.all(written.map((p) => fs.unlink(p).catch(() => {})));
    throw e;
  }
}
function attach(router) {
  router.get(
    base + "/index",
    C.route(async (req, res) => {
      doctor(req);
      const r = await jobs(getPool());
      C.page(req, res, "onboarding/doctor/jobs/index", "الوظائف المتاحة", [
        C.table("وظائف العيادات", r.rows, [
          col("Job_Title", "الوظيفة", (r) => base + "/details?job=" + r.Job_ID),
          col("Clinic_Name", "العيادة"),
          col("City", "المدينة"),
          col("Name_AR", "التخصص"),
          col("Minimum_Experience_Years", "الخبرة المطلوبة"),
          col("Application_Deadline", "آخر موعد"),
        ]),
        {
          title: "طلباتي",
          links: [
            {
              href: base + "/application-status",
              label: "متابعة طلبات التوظيف",
            },
          ],
        },
      ]);
    }),
  );
  router.get(
    base + "/details",
    C.route(async (req, res) => {
      doctor(req);
      const r = await jobs(getPool(), C.id(req.query.job));
      if (!r.rowCount) throw C.error("الوظيفة غير متاحة.", 404);
      const j = r.rows[0];
      const form = C.form(
        "التقديم للوظيفة",
        base + "/apply",
        [
          C.field("city", "مدينة السكن"),
          {
            ...C.field("salary", "الراتب المتوقع (اختياري)", "", "number"),
            required: false,
          },
          {
            ...C.field("cover", "رسالة التقديم", "", "textarea"),
            required: false,
          },
          {
            ...C.field(
              "attachments",
              "مرفق داعم حتى 5MB بصيغة PDF أو صورة",
              "",
              "file",
            ),
            required: false,
          },
          C.field(
            "consent",
            "أوافق على مشاركة بيانات ملفي المهني ومرفقاتي مع هذه العيادة",
            false,
            "checkbox",
          ),
        ],
        { job_id: j.Job_ID },
        "إرسال الطلب",
      );
      form.form.multipart = true;
      C.page(req, res, "onboarding/doctor/jobs/details", j.Job_Title, [
        {
          title: j.Clinic_Name + " — " + j.City,
          text: [
            j.Summary,
            j.Responsibilities,
            j.Requirements,
            j.Salary_Description,
          ].join("\n"),
        },
        form,
      ]);
    }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 12, parts: 15 },
  }).array("attachments", 3);
  router.post(
    base + "/apply",
    express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 12 }),
    (req, res, next) =>
      upload(req, res, (e) =>
        e
          ? res.status(422).send("ملف غير صالح أو يتجاوز الحجم المسموح.")
          : next(),
      ),
    C.post(async (req, res) => {
      const result = await apply(req);
      res.redirect(
        303,
        base + "/application-preview?application=" + result.id + "&saved=1",
      );
    }),
  );
  for (const suffix of ["application-status", "application-preview"])
    router.get(
      base + "/" + suffix,
      C.route(async (req, res) => {
        const a = doctor(req),
          id = req.query.application ? C.id(req.query.application) : null;
        const r = await getPool().query(
          `SELECT a."Application_ID"::text id,a."Application_Status" status,a."Applied_At" created,a."Full_Name" name,a."Specialty_Name" specialty,a."Expected_Salary" salary,a."Cover_Letter" cover,a."Clinic_Feedback" feedback,j."Job_Title" job,c."Clinic_Name" clinic FROM sdc."APPLIES_FOR" a JOIN sdc."JOB" j USING("Job_ID") JOIN sdc."CLINIC" c USING("Clinic_ID") WHERE a."Doctor_ID"=$1 AND ($2::bigint IS NULL OR a."Application_ID"=$2) ORDER BY a."Applied_At" DESC LIMIT 200`,
          [a.doctorId, id],
        );
        if (id && !r.rowCount) throw C.error("الطلب غير موجود.", 404);
        const sections = [
          C.table("طلبات التوظيف", r.rows, [
            col(
              "id",
              "الطلب",
              (r) => base + "/application-preview?application=" + r.id,
            ),
            col("job", "الوظيفة"),
            col("clinic", "العيادة"),
            col("status", "الحالة"),
            col("created", "التاريخ"),
            col("feedback", "ملاحظة العيادة"),
          ]),
        ];
        if (id) {
          const d = r.rows[0];
          sections.push({
            title: "نسخة طلب التقديم",
            text: [d.name, d.specialty, d.cover].filter(Boolean).join("\n"),
          });
          const files = await getPool().query(
            'SELECT "Attachment_ID"::text id,"File_Name" name FROM sdc."JOB_APPLICATION_ATTACHMENTS" WHERE "Application_ID"=$1',
            [id],
          );
          sections.push(
            C.table("مرفقات الطلب", files.rows, [
              col(
                "name",
                "الملف",
                (f) => base + "/attachment?application=" + id + "&file=" + f.id,
              ),
            ]),
          );
          if (d.status === "pending")
            sections.push(
              C.form(
                "سحب الطلب",
                base + "/withdraw",
                [],
                { application_id: id },
                "سحب طلب التوظيف",
              ),
            );
        }
        C.page(
          req,
          res,
          "onboarding/doctor/jobs/" + suffix,
          "متابعة طلبات التوظيف",
          sections,
        );
      }),
    );
  router.post(
    base + "/withdraw",
    express.urlencoded({ extended: false, limit: "4kb" }),
    C.post(async (req, res) => {
      const a = doctor(req),
        id = C.id(req.body.application_id);
      await C.tx(a.userId, async (db) => {
        const r = await db.query(
          `UPDATE sdc."APPLIES_FOR" SET "Application_Status"='withdrawn' WHERE "Application_ID"=$1 AND "Doctor_ID"=$2 AND "Application_Status"='pending' RETURNING "Application_ID"`,
          [id, a.doctorId],
        );
        if (!r.rowCount) throw C.error("لا يمكن سحب هذا الطلب.", 409);
        await C.audit(
          db,
          a.userId,
          "job.application.withdrawn",
          "Application",
          id,
          "سحب الطبيب طلب التوظيف",
        );
      });
      res.redirect(303, base + "/application-status?saved=1");
    }),
  );
  router.get(
    base + "/attachment",
    C.route(async (req, res) => {
      const a = doctor(req);
      const r = await getPool().query(
        'SELECT f."File_Reference" ref FROM sdc."JOB_APPLICATION_ATTACHMENTS" f JOIN sdc."APPLIES_FOR" a USING("Application_ID") WHERE f."Attachment_ID"=$1 AND a."Application_ID"=$2 AND a."Doctor_ID"=$3',
        [C.id(req.query.file), C.id(req.query.application), a.doctorId],
      );
      const file = r.rowCount ? docs.documentPath(r.rows[0].ref) : null;
      if (!file) throw C.error("الملف غير موجود.", 404);
      res.set({
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.download(file, "attachment" + path.extname(file));
    }),
  );
}
module.exports = { attach, apply };
