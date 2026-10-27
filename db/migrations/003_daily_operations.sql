-- Smart Dental Clinic: attendance tracking in the EXISTING booking table.
-- Run once in pgAdmin, connected to the smart_dental_clinic database.
-- This migration does not delete/replace any rows.
BEGIN;
ALTER TABLE sdc."BOOKING" ADD COLUMN IF NOT EXISTS "Arrived_At" TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_sdc_booking_clinic_day_arrived
  ON sdc."BOOKING" ("Clinic_ID", "Appointment_Date", "Arrived_At");
COMMIT;
