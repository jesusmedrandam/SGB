BEGIN;
ALTER TABLE livestock_activity ADD COLUMN procedure jsonb;
ALTER TABLE livestock_activity ADD CONSTRAINT activity_procedure_object CHECK(procedure IS NULL OR jsonb_typeof(procedure)='object');
COMMIT;
