-- Run once after installing the user-supplied 57-table SQL schema.
-- The account's global role must be Patient (System scope).
INSERT INTO sdc."ROLE" ("Role_Name", "Role_Scope")
VALUES ('Patient', 'System')
ON CONFLICT ("Role_Name", "Role_Scope") DO NOTHING;
