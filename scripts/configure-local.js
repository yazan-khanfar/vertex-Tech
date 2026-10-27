"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  file = path.join(root, ".env");
if (fs.existsSync(file)) {
  console.log("Existing local configuration retained.");
  process.exit(0);
}
const values = {
  NODE_ENV: "development",
  PORT: "3000",
  DATABASE_URL: "postgresql://sdc_dev@127.0.0.1:55432/smart_dental_clinic",
  POLICY_VERSION: "prototype-v1",
  APP_BASE_URL: "http://localhost:3000",
  PASSWORD_RESET_DELIVERY: "console",
  MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
  CSRF_SECRET: crypto.randomBytes(32).toString("hex"),
  SDC_VISIT_FILES_DIR: path.join(root, ".local/visit-files"),
  CLINIC_DOCUMENTS_DIR: path.join(root, ".local/clinic-documents"),
  SDC_PDF_BROWSER: path.join(root, "scripts/render-pdf.js"),
  SDC_CHROMIUM_NO_SANDBOX: "1",
};
fs.writeFileSync(
  file,
  Object.entries(values)
    .map(([k, v]) => k + "=" + v)
    .join("\n") + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Created private development configuration; values were not printed.",
);
