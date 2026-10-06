BEGIN;
ALTER TABLE health_medicine
 ADD COLUMN dose_classification_ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD CONSTRAINT health_medicine_classification_reference CHECK (
   CASE WHEN jsonb_typeof(dose_classification_ranges)='array'
   THEN jsonb_array_length(dose_classification_ranges)<=6
     AND (jsonb_array_length(dose_classification_ranges)=0
       OR (dose_amount IS NULL AND dose_weight IS NULL AND dose_weight_unit_code IS NULL))
   ELSE false END);
COMMIT;
