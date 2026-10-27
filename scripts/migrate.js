"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
if (fs.existsSync(path.join(root, ".env")))
  process.loadEnvFile(path.join(root, ".env"));
const { getPool } = require("../db/pool");
(async () => {
  const pool = getPool(),
    db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(534443,570407)");
    const schema = await db.query(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='sdc') present",
    );
    if (
      process.argv.includes("--init") ||
      (!schema.rows[0].present && process.argv.includes("--init-if-empty"))
    ) {
      if (schema.rows[0].present)
        throw Error(
          "Schema already exists. Use npm run db:migrate; initialization never replaces existing data.",
        );
      const tables = await db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') LIMIT 1",
      );
      if (tables.rowCount)
        throw Error("Initialization requires an empty database.");
      await db.query(
        fs.readFileSync(
          path.join(root, "db/schema/001_Smart_Dental_Clinic_Original.sql"),
          "utf8",
        ),
      );
    } else if (!schema.rows[0].present)
      throw Error("An empty development database needs npm run db:init first.");
    await db.query(
      'CREATE TABLE IF NOT EXISTS sdc."_MIGRATION_LOG" (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    for (const file of fs
      .readdirSync(path.join(root, "db/migrations"))
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort()) {
      const sql = fs.readFileSync(
          path.join(root, "db/migrations", file),
          "utf8",
        ),
        hash = crypto.createHash("sha256").update(sql).digest("hex");
      const old = await db.query(
        'SELECT checksum FROM sdc."_MIGRATION_LOG" WHERE name=$1',
        [file],
      );
      if (old.rowCount) {
        if (old.rows[0].checksum !== hash)
          throw Error(
            "An applied migration changed: " +
              file +
              ". Add a new migration instead.",
          );
        continue;
      }
      try {
        await db.query("BEGIN");
        await db.query(
          sql.replace(/^\s*BEGIN\s*;/m, "").replace(/COMMIT;\s*$/, ""),
        );
        await db.query(
          'INSERT INTO sdc."_MIGRATION_LOG"(name,checksum) VALUES($1,$2)',
          [file, hash],
        );
        await db.query("COMMIT");
        console.log("Applied migration:", file);
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(534443,570407)").catch(() => {});
    db.release();
    await pool.end();
  }
})().catch((e) => {
  console.error("Database setup failed:", e.code || e.message);
  process.exitCode = 1;
});
