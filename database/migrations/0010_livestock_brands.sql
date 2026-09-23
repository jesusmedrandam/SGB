BEGIN;

-- La marquilla identifica un fierro reutilizable, no el arete individual.
CREATE TABLE livestock_brand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid NOT NULL,
  name varchar(160) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT livestock_brand_property_account_fk FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CONSTRAINT livestock_brand_id_property_unique UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX livestock_brand_name_property_unique
ON livestock_brand(property_id, lower(name));

CREATE TRIGGER livestock_brand_touch_updated_at BEFORE UPDATE ON livestock_brand
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER livestock_brand_no_direct_delete BEFORE DELETE ON livestock_brand
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE animal_brand_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id uuid NOT NULL REFERENCES animal(id),
  property_id uuid NOT NULL REFERENCES property(id),
  brand_id uuid NOT NULL,
  assigned_by uuid NOT NULL REFERENCES app_user(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid REFERENCES app_user(id),
  CONSTRAINT animal_brand_assignment_brand_fk FOREIGN KEY (brand_id, property_id)
    REFERENCES livestock_brand(id, property_id),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

CREATE UNIQUE INDEX animal_current_brand_unique ON animal_brand_assignment(animal_id, brand_id)
WHERE ended_at IS NULL;
CREATE INDEX animal_brand_history_idx ON animal_brand_assignment(animal_id, assigned_at DESC);

CREATE FUNCTION validate_animal_brand_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM animal a WHERE a.id = NEW.animal_id
      AND a.property_id = NEW.property_id AND a.record_status = 'CURRENT')
    OR NOT EXISTS (SELECT 1 FROM livestock_brand b WHERE b.id = NEW.brand_id
      AND b.property_id = NEW.property_id AND b.active) THEN
    RAISE EXCEPTION 'La marquilla no está disponible para este animal y propiedad.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_brand_assignment_validate BEFORE INSERT ON animal_brand_assignment
FOR EACH ROW EXECUTE FUNCTION validate_animal_brand_assignment();

CREATE FUNCTION protect_animal_brand_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.animal_id IS DISTINCT FROM OLD.animal_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
    OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
    OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
    OR NEW.ended_at IS NULL OR NEW.ended_by IS NULL THEN
    RAISE EXCEPTION 'El historial de marquillas no puede reescribirse.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_brand_assignment_protect BEFORE UPDATE ON animal_brand_assignment
FOR EACH ROW EXECUTE FUNCTION protect_animal_brand_assignment();

CREATE TRIGGER animal_brand_assignment_no_direct_delete BEFORE DELETE ON animal_brand_assignment
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

COMMIT;
