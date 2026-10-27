"use strict";
let cached = "Smart Dental Clinic";
let expires = 0;
async function locals(req, res, next) {
  try {
    if (Date.now() >= expires && process.env.DATABASE_URL) {
      try {
        const row = await require("../../db/pool")
          .getPool()
          .query(
            'SELECT "Setting_Value" value FROM sdc."PLATFORM_SETTINGS" WHERE "Setting_Key"=\'platform_name\'',
          );
        cached = row.rows[0]?.value || "Smart Dental Clinic";
        expires = Date.now() + 5000;
      } catch (e) {
        if (e.code !== "42P01") throw e;
      }
    }
    res.locals.platformName = cached;
    next();
  } catch (e) {
    next(e);
  }
}
function invalidate() {
  expires = 0;
}
module.exports = { locals, invalidate };
