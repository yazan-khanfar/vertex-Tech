#!/usr/bin/env node
"use strict";
// Adapter for self-contained reports. The opt-in no-sandbox mode is for isolated development only.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { fileURLToPath } = require("node:url");
const { chromium } = require("playwright-core");
const local = path.resolve(__dirname, "../.local");
process.env.XDG_CONFIG_HOME ||= path.join(local, "xdg-config");
process.env.XDG_CACHE_HOME ||= path.join(local, "xdg-cache");
for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME"])
  fs.mkdirSync(process.env[name], { recursive: true });
(async () => {
  const output = process.argv
      .find((a) => a.startsWith("--print-to-pdf="))
      ?.slice("--print-to-pdf=".length),
    source = process.argv.find((a) => a.startsWith("file://"));
  if (!output || !path.isAbsolute(output) || !source)
    throw Error("Local report and PDF output are required.");
  const browser = await chromium.launch({
    executablePath: process.env.SDC_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      ...(process.env.SDC_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    timeout: 10000,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fs.readFileSync(fileURLToPath(source), "utf8"), {
      waitUntil: "load",
      timeout: 10000,
    });
    await page.pdf({
      path: output,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      timeout: 10000,
    });
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
