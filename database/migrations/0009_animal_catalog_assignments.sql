BEGIN;

CREATE TABLE animal_catalog_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animal(id),
  property_id uuid NOT NULL REFERENCES property(id),
  catalog_code varchar(80) NOT NULL CHECK (catalog_code IN ('BREEDS', 'COLORS')),
  catalog_item_id uuid NOT NULL REFERENCES governed_catalog_item(id),
  assigned_by uuid NOT NULL REFERENCES app_user(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid REFERENCES app_user(id),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

CREATE UNIQUE INDEX animal_one_current_breed
  ON animal_catalog_assignment(animal_id)
  WHERE catalog_code = 'BREEDS' AND ended_at IS NULL;

CREATE UNIQUE INDEX animal_current_catalog_item_unique
  ON animal_catalog_assignment(animal_id, catalog_item_id)
  WHERE ended_at IS NULL;

CREATE INDEX animal_catalog_assignment_history_idx
  ON animal_catalog_assignment(animal_id, assigned_at DESC);

CREATE FUNCTION validate_animal_catalog_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_animal animal%ROWTYPE;
BEGIN
  IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
    RAISE EXCEPTION 'Una selección nueva debe estar vigente.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO current_animal FROM animal WHERE id = NEW.animal_id;
  IF NOT FOUND OR current_animal.property_id <> NEW.property_id
    OR current_animal.record_status <> 'CURRENT' THEN
    RAISE EXCEPTION 'El animal no está vigente en la propiedad indicada.' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM governed_catalog_item ci
    WHERE ci.id = NEW.catalog_item_id
      AND ci.catalog_code = NEW.catalog_code
      AND ci.active AND ci.deleted_at IS NULL
      AND (ci.system_defined OR ci.property_id = NEW.property_id)
      AND (ci.species_code IS NULL OR ci.species_code = current_animal.species_code)
  ) THEN
    RAISE EXCEPTION 'La raza o el color no es válido para este animal.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_catalog_assignment_validate
BEFORE INSERT ON animal_catalog_assignment
FOR EACH ROW EXECUTE FUNCTION validate_animal_catalog_assignment();

CREATE FUNCTION protect_animal_catalog_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.animal_id IS DISTINCT FROM OLD.animal_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.catalog_code IS DISTINCT FROM OLD.catalog_code
    OR NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
    OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
    OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
    OR NEW.ended_at IS NULL OR NEW.ended_by IS NULL THEN
    RAISE EXCEPTION 'El historial de razas y colores no puede reescribirse.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_catalog_assignment_protect
BEFORE UPDATE ON animal_catalog_assignment
FOR EACH ROW EXECUTE FUNCTION protect_animal_catalog_assignment();

CREATE TRIGGER animal_catalog_assignment_no_direct_delete
BEFORE DELETE ON animal_catalog_assignment
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

COMMIT;
