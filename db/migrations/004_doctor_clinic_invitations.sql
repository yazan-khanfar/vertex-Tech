-- Safe extension of the existing WORKS_AT membership status values.
-- Required once before installing the Clinic Doctors v15 backend.
-- Does NOT delete any doctors or memberships.
BEGIN;
ALTER TABLE sdc."WORKS_AT" DROP CONSTRAINT IF EXISTS ck_works_at_membership_status;
ALTER TABLE sdc."WORKS_AT" ADD CONSTRAINT ck_works_at_membership_status
  CHECK ("Membership_Status" IN ('pending','active','suspended','inactive'));
COMMIT;
