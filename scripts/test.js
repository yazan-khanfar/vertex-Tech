"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
if (fs.existsSync(path.join(root, ".env")))
  process.loadEnvFile(path.join(root, ".env"));
process.env.SDC_VISIT_FILES_DIR ||= path.join(root, ".local/visit-files");
process.env.CLINIC_DOCUMENTS_DIR ||= path.join(root, ".local/clinic-documents");
const runs = [
  ["tests/verify-structure.js"],
  ["tests/verify-routing-contract.js"],
  ["tests/verify-unified-layouts.js"],
  [
    "--test",
    "--test-concurrency=4",
    ...fs
      .readdirSync(path.join(root, "tests"))
      .filter((n) => n.endsWith(".test.js"))
      .sort()
      .map((n) => "tests/" + n),
  ],
  ["tests/smoke-visit-live-v26-2.js"],
];
for (const args of runs) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
