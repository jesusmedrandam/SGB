BEGIN;

-- The former system allows milking after a recent birth before a lactation is created.
CREATE TABLE milk_animal_state (
  cow_id uuid PRIMARY KEY REFERENCES animal(id),
  property_id uuid NOT NULL,
  account_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id)
);
INSERT INTO milk_animal_state(cow_id,property_id,account_id,enabled,updated_by)
SELECT l.cow_id,l.property_id,l.account_id,l.in_milking,l.created_by
FROM milk_lactation l WHERE l.ended_on IS NULL
ON CONFLICT(cow_id) DO NOTHING;

ALTER TABLE milk_production ALTER COLUMN lactation_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION validate_milk_production() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM animal a JOIN milk_animal_state ms ON ms.cow_id=a.id
    LEFT JOIN reproduction_setting s ON s.property_id=a.property_id
    WHERE a.id=NEW.cow_id AND a.account_id=NEW.account_id AND a.property_id=NEW.property_id
      AND a.sex='FEMALE' AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE'
      AND ms.enabled AND ms.account_id=NEW.account_id AND ms.property_id=NEW.property_id
      AND EXISTS(SELECT 1 FROM reproduction_birth b WHERE b.mother_id=a.id
        AND b.property_id=a.property_id AND NEW.produced_on BETWEEN b.occurred_on
          AND b.occurred_on+COALESCE(s.max_milking_days,305)))
    OR (NEW.lactation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM milk_lactation l
      WHERE l.id=NEW.lactation_id AND l.cow_id=NEW.cow_id
        AND l.account_id=NEW.account_id AND l.property_id=NEW.property_id
        AND l.in_milking AND NEW.produced_on>=l.started_on
        AND (l.ended_on IS NULL OR NEW.produced_on<=l.ended_on)))
    OR (NEW.lactation_id IS NULL AND EXISTS (SELECT 1 FROM milk_lactation l
      WHERE l.cow_id=NEW.cow_id AND l.property_id=NEW.property_id AND l.ended_on IS NULL)) THEN
    RAISE EXCEPTION 'La vaca debe estar en ordeño tras un parto reciente.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_milk_animal_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM animal a WHERE a.id=NEW.cow_id
    AND a.property_id=NEW.property_id AND a.account_id=NEW.account_id AND a.sex='FEMALE') THEN
    RAISE EXCEPTION 'El estado de ordeño debe pertenecer a una vaca de esta propiedad.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER milk_animal_state_validate BEFORE INSERT OR UPDATE ON milk_animal_state
FOR EACH ROW EXECUTE FUNCTION validate_milk_animal_state();
CREATE TRIGGER milk_animal_state_no_delete BEFORE DELETE ON milk_animal_state
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

COMMIT;
