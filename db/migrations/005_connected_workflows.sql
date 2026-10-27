BEGIN;
ALTER TABLE sdc."PATIENT" ADD COLUMN IF NOT EXISTS "Health_Profile_Completed_At" TIMESTAMP;
ALTER TABLE sdc."PATIENT" ADD COLUMN IF NOT EXISTS "Profile_Version" integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sdc."ACTION_RECEIPTS" (
 "Actor_ID" bigint NOT NULL REFERENCES sdc."USER"("User_ID"),
 "Request_Key" uuid NOT NULL,
 "Operation" text NOT NULL,
 "Payload_Hash" text NOT NULL,
 "Result" jsonb NOT NULL,
 "Created_At" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("Actor_ID","Request_Key")
);
CREATE TABLE IF NOT EXISTS sdc."PLATFORM_SETTINGS" (
 "Setting_Key" text PRIMARY KEY,
 "Setting_Value" text NOT NULL,
 "Updated_By" bigint NOT NULL REFERENCES sdc."USER"("User_ID"),
 "Updated_At" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sdc_user_email_normalized ON sdc."USER" (lower(btrim("Email"))) WHERE "Email" IS NOT NULL;
COMMIT;
