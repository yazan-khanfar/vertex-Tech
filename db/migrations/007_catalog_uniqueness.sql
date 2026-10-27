BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sdc_specialty_name_en ON sdc."SPECIALTY"(lower(btrim("Name_EN")));
CREATE UNIQUE INDEX IF NOT EXISTS ux_sdc_service_name ON sdc."SERVICE"(lower(btrim("Service_Name")));
COMMIT;
