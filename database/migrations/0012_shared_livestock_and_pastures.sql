BEGIN;

-- Existing identifiers and history remain intact; the original property_id is provenance.
INSERT INTO governed_catalog_item(catalog_code, item_code, name, species_code, system_defined)
VALUES
  ('COLORS','BOVINE_WHITE','Blanco','BOVINE',true),
  ('COLORS','BOVINE_BLACK','Negro','BOVINE',true),
  ('COLORS','BOVINE_RED','Rojo','BOVINE',true),
  ('COLORS','BOVINE_YELLOW','Amarillo','BOVINE',true),
  ('BREEDS','BOVINE_BRAHMAN','Brahman','BOVINE',true),
  ('BREEDS','BOVINE_HOLSTEIN','Holstein','BOVINE',true),
  ('BREEDS','BOVINE_JERSEY','Jersey','BOVINE',true),
  ('BREEDS','BOVINE_GYR','Gyr','BOVINE',true),
  ('BREEDS','BOVINE_GIROLANDO','Girolando','BOVINE',true),
  ('BREEDS','BOVINE_BROWN_SWISS','Pardo Suizo','BOVINE',true),
  ('BREEDS','BOVINE_SIMMENTAL','Simmental','BOVINE',true),
  ('BREEDS','BOVINE_ANGUS','Angus','BOVINE',true);

DELETE FROM allowed_context_unit WHERE context_code = 'ANIMAL_WEIGHT' AND unit_code = 'GRAM';
-- Historical weights in grams remain readable; new animals must use kg or lb.
CREATE FUNCTION validate_new_animal_weight_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.initial_weight_unit_code IS NOT NULL
     AND NEW.initial_weight_unit_code NOT IN ('KILOGRAM', 'POUND') THEN
    RAISE EXCEPTION 'El peso de animales se registra en kg o lb.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER animal_weight_unit_new BEFORE INSERT OR UPDATE OF initial_weight_unit_code
ON animal FOR EACH ROW EXECUTE FUNCTION validate_new_animal_weight_unit();

DROP INDEX animal_one_current_breed;
CREATE OR REPLACE FUNCTION validate_animal_catalog_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_animal animal%ROWTYPE;
BEGIN
  IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
    RAISE EXCEPTION 'Una selección nueva debe estar vigente.' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO current_animal FROM animal WHERE id = NEW.animal_id;
  IF NOT FOUND OR current_animal.property_id <> NEW.property_id
    OR current_animal.record_status <> 'CURRENT' THEN
    RAISE EXCEPTION 'El animal no está vigente en la propiedad indicada.' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM governed_catalog_item ci
    WHERE ci.id = NEW.catalog_item_id AND ci.catalog_code = NEW.catalog_code
      AND ci.active AND ci.deleted_at IS NULL
      AND (ci.system_defined OR ci.account_id = current_animal.account_id)
      AND (ci.species_code IS NULL OR ci.species_code = current_animal.species_code)) THEN
    RAISE EXCEPTION 'La raza o el color no es válido para este animal.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE animal_brand_assignment DROP CONSTRAINT animal_brand_assignment_brand_fk;
CREATE OR REPLACE FUNCTION validate_animal_brand_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM animal a WHERE a.id = NEW.animal_id
      AND a.property_id = NEW.property_id AND a.record_status = 'CURRENT')
    OR NOT EXISTS (SELECT 1 FROM livestock_brand b JOIN animal a ON a.id = NEW.animal_id
      WHERE b.id = NEW.brand_id AND b.account_id = a.account_id AND b.active) THEN
    RAISE EXCEPTION 'La marquilla no está disponible para este animal y cuenta.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Allow ownership parties created at another property in the same account.
ALTER TABLE property_party ADD CONSTRAINT property_party_id_account_unique UNIQUE(id, account_id);
ALTER TABLE animal_ownership ADD COLUMN account_id uuid;
UPDATE animal_ownership ao SET account_id = p.account_id FROM property p WHERE p.id = ao.property_id;
ALTER TABLE animal_ownership ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE animal_ownership DROP CONSTRAINT animal_ownership_party_property_fk;
ALTER TABLE animal_ownership ADD CONSTRAINT animal_ownership_party_account_fk
  FOREIGN KEY(party_id, account_id) REFERENCES property_party(id, account_id);
ALTER TABLE animal_ownership ADD CONSTRAINT animal_ownership_property_account_fk
  FOREIGN KEY(property_id, account_id) REFERENCES property(id, account_id);

ALTER TABLE livestock_brand ADD CONSTRAINT livestock_brand_id_account_unique UNIQUE(id, account_id);
CREATE TABLE livestock_brand_owner (
  brand_id uuid NOT NULL,
  party_id uuid NOT NULL,
  account_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(brand_id, party_id),
  FOREIGN KEY(brand_id, account_id) REFERENCES livestock_brand(id, account_id),
  FOREIGN KEY(party_id, account_id) REFERENCES property_party(id, account_id)
);

-- Pasture details follow the previous SGB's pasture model.
ALTER TABLE physical_location
  ADD COLUMN pasture_use varchar(80),
  ADD COLUMN capacity_estimate integer CHECK(capacity_estimate IS NULL OR capacity_estimate >= 0),
  ADD COLUMN water_available boolean,
  ADD COLUMN last_rest_date date,
  ADD COLUMN floor_material varchar(100),
  ADD COLUMN covered boolean,
  ADD CONSTRAINT location_kind_details CHECK (
    kind = 'PASTURE' OR (pasture_use IS NULL AND last_rest_date IS NULL)
  );
CREATE TABLE pasture_grass (
  location_id uuid NOT NULL REFERENCES physical_location(id),
  name varchar(160) NOT NULL,
  estimated_percent numeric(5,2) CHECK(estimated_percent BETWEEN 0 AND 100),
  area_value numeric(14,4) CHECK(area_value IS NULL OR area_value > 0),
  area_unit_code varchar(30) REFERENCES measurement_unit(code),
  sowing_date date,
  notes varchar(300),
  PRIMARY KEY(location_id, name),
  CHECK ((area_value IS NULL) = (area_unit_code IS NULL))
);
CREATE FUNCTION validate_pasture_grass() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM physical_location WHERE id = NEW.location_id AND kind = 'PASTURE')
    OR (NEW.area_unit_code IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM allowed_context_unit
      WHERE context_code = 'LAND_AREA' AND unit_code = NEW.area_unit_code)) THEN
    RAISE EXCEPTION 'El pasto requiere un potrero y una unidad de área válida.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pasture_grass_validate BEFORE INSERT OR UPDATE ON pasture_grass
FOR EACH ROW EXECUTE FUNCTION validate_pasture_grass();

COMMIT;
