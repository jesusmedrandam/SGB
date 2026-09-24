BEGIN;

-- A first placement has no source location. Keep the destination mandatory.
DO $$
DECLARE old_constraint text;
BEGIN
  SELECT conname INTO old_constraint FROM pg_constraint
   WHERE conrelid='livestock_movement'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%source_location_id IS NOT NULL%'
     AND pg_get_constraintdef(oid) LIKE '%destination_location_id IS NOT NULL%';
  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE livestock_movement DROP CONSTRAINT %I',old_constraint);
  END IF;
END $$;

ALTER TABLE livestock_movement
  ADD CONSTRAINT livestock_movement_location_rules
  CHECK(kind<>'UBICACION' OR (selection_mode='GRUPO'
    AND source_group_id=destination_group_id AND destination_location_id IS NOT NULL
    AND (source_location_id IS NULL OR source_location_id<>destination_location_id)));

COMMIT;
