-- Run ONCE in pgAdmin on smart_dental_clinic, after taking a backup.
-- Non-destructive extension of the existing sdc."USER_SESSIONS" table.
BEGIN;
ALTER TABLE sdc."USER_SESSIONS"
  ADD COLUMN IF NOT EXISTS "Session_Token_Hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "Last_Seen_At" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "Active_Clinic_ID" BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sdc_user_sessions_token_hash
  ON sdc."USER_SESSIONS" ("Session_Token_Hash")
  WHERE "Session_Token_Hash" IS NOT NULL;
COMMIT;
