BEGIN;

INSERT INTO permission_catalog(code, module_code, name, description) VALUES
  ('PRODUCTION_VIEW','PRODUCTION','Consultar producción','Consultar lactancias, ordeños y tanques de la propiedad.'),
  ('PRODUCTION_MANAGE','PRODUCTION','Registrar producción','Registrar lactancias y producción de leche.');
INSERT INTO role_template_permission(role_code, permission_code)
SELECT rt.code, pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code = 'PRODUCTION_VIEW' OR
  (pc.code = 'PRODUCTION_MANAGE' AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id, permission_code)
SELECT pr.id, rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code = pr.code
WHERE pr.is_system AND rtp.permission_code IN ('PRODUCTION_VIEW','PRODUCTION_MANAGE')
ON CONFLICT DO NOTHING;

ALTER TABLE reproduction_setting ADD COLUMN max_milking_days integer NOT NULL DEFAULT 305
  CHECK(max_milking_days BETWEEN 1 AND 730);

CREATE TABLE reproduction_service (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  cow_id uuid NOT NULL REFERENCES animal(id),
  heat_id uuid REFERENCES reproduction_heat(id),
  father_id uuid REFERENCES animal(id),
  external_father varchar(240),
  donor_id uuid REFERENCES animal(id),
  external_donor varchar(240),
  kind varchar(30) NOT NULL CHECK(kind IN ('INSEMINATION','EMBRYO_TRANSFER')),
  occurred_on date NOT NULL,
  material_code varchar(160), quality varchar(120), technician varchar(160),
  supplier varchar(160), notes varchar(2000),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES app_user(id),
  FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
  CHECK(father_id IS NULL OR external_father IS NULL),
  CHECK(donor_id IS NULL OR external_donor IS NULL),
  CHECK(kind = 'EMBRYO_TRANSFER' OR (donor_id IS NULL AND external_donor IS NULL)),
  CHECK((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX reproduction_service_property_date ON reproduction_service(property_id,occurred_on DESC);
ALTER TABLE reproduction_pregnancy ADD COLUMN service_id uuid REFERENCES reproduction_service(id);
CREATE UNIQUE INDEX reproduction_pregnancy_service_unique ON reproduction_pregnancy(service_id)
WHERE service_id IS NOT NULL AND status <> 'CANCELLED';

CREATE FUNCTION validate_reproduction_service() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM animal a WHERE a.id=NEW.cow_id
    AND a.account_id=NEW.account_id AND a.property_id=NEW.property_id
    AND a.sex='FEMALE' AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE')
    OR (NEW.heat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reproduction_heat h
      WHERE h.id=NEW.heat_id AND h.cow_id=NEW.cow_id AND h.property_id=NEW.property_id
        AND h.account_id=NEW.account_id AND h.cancelled_at IS NULL AND NOT h.is_false
        AND h.starts_on <= NEW.occurred_on))
    OR (NEW.father_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM animal a
      WHERE a.id=NEW.father_id AND a.account_id=NEW.account_id
        AND a.sex='MALE' AND a.record_status='CURRENT'))
    OR (NEW.donor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM animal a
      WHERE a.id=NEW.donor_id AND a.account_id=NEW.account_id
        AND a.sex='FEMALE' AND a.record_status='CURRENT')) THEN
    RAISE EXCEPTION 'El servicio no corresponde a estos animales y esta cuenta.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reproduction_service_validate BEFORE INSERT ON reproduction_service
FOR EACH ROW EXECUTE FUNCTION validate_reproduction_service();

CREATE FUNCTION validate_pregnancy_service() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reproduction_service s
    WHERE s.id=NEW.service_id AND s.account_id=NEW.account_id AND s.property_id=NEW.property_id
      AND s.cow_id=NEW.cow_id AND s.cancelled_at IS NULL AND s.occurred_on <= NEW.confirmed_on
      AND s.kind=NEW.conception_method AND s.heat_id IS NOT DISTINCT FROM NEW.heat_id
      AND s.father_id IS NOT DISTINCT FROM NEW.father_id
      AND s.external_father IS NOT DISTINCT FROM NEW.external_father) THEN
    RAISE EXCEPTION 'El servicio no corresponde a esta preñez.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reproduction_pregnancy_service_validate BEFORE INSERT OR UPDATE OF service_id
ON reproduction_pregnancy FOR EACH ROW EXECUTE FUNCTION validate_pregnancy_service();

CREATE TABLE milk_lactation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  cow_id uuid NOT NULL REFERENCES animal(id),
  birth_id uuid NOT NULL UNIQUE REFERENCES reproduction_birth(id),
  started_on date NOT NULL,
  ended_on date,
  in_milking boolean NOT NULL DEFAULT true,
  notes varchar(2000),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
  CHECK(ended_on IS NULL OR ended_on >= started_on),
  CHECK(ended_on IS NULL OR NOT in_milking)
);
CREATE UNIQUE INDEX milk_lactation_one_open ON milk_lactation(cow_id) WHERE ended_on IS NULL;
CREATE INDEX milk_lactation_property_date ON milk_lactation(property_id,started_on DESC);

CREATE TABLE milk_production (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  cow_id uuid NOT NULL REFERENCES animal(id),
  lactation_id uuid NOT NULL REFERENCES milk_lactation(id),
  produced_on date NOT NULL,
  shift varchar(12) NOT NULL CHECK(shift IN ('MORNING','AFTERNOON','NIGHT','SINGLE')),
  liters numeric(12,3) NOT NULL CHECK(liters >= 0),
  source varchar(12) NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','SENSOR')),
  external_reference varchar(160),
  notes varchar(2000),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
  UNIQUE(cow_id,produced_on,shift)
);
CREATE INDEX milk_production_property_date ON milk_production(property_id,produced_on DESC);

CREATE TABLE milk_tank_production (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  produced_on date NOT NULL,
  shift varchar(12) NOT NULL CHECK(shift IN ('MORNING','AFTERNOON','NIGHT','SINGLE')),
  liters numeric(12,3) NOT NULL CHECK(liters >= 0),
  source varchar(12) NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','SENSOR')),
  external_reference varchar(160),
  notes varchar(2000),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
  UNIQUE(property_id,produced_on,shift,source)
);
CREATE INDEX milk_tank_property_date ON milk_tank_production(property_id,produced_on DESC);

CREATE FUNCTION validate_milk_lactation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reproduction_birth b JOIN animal a ON a.id=b.mother_id
    WHERE b.id=NEW.birth_id AND b.mother_id=NEW.cow_id AND b.account_id=NEW.account_id
      AND b.property_id=NEW.property_id AND b.occurred_on=NEW.started_on
      AND a.sex='FEMALE' AND a.record_status='CURRENT') THEN
    RAISE EXCEPTION 'La lactancia debe pertenecer al parto de esta vaca.' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM milk_lactation l WHERE l.cow_id=NEW.cow_id AND l.id<>NEW.id
    AND daterange(l.started_on,COALESCE(l.ended_on,'infinity'::date),'[]')
      && daterange(NEW.started_on,COALESCE(NEW.ended_on,'infinity'::date),'[]')) THEN
    RAISE EXCEPTION 'Las lactancias de esta vaca se superponen.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER milk_lactation_validate BEFORE INSERT OR UPDATE OF ended_on ON milk_lactation
FOR EACH ROW EXECUTE FUNCTION validate_milk_lactation();

CREATE FUNCTION validate_milk_production() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM milk_lactation l JOIN animal a ON a.id=l.cow_id
    LEFT JOIN reproduction_setting s ON s.property_id=l.property_id
    WHERE l.id=NEW.lactation_id AND l.cow_id=NEW.cow_id AND l.account_id=NEW.account_id
      AND l.property_id=NEW.property_id AND l.in_milking
      AND a.sex='FEMALE' AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE'
      AND NEW.produced_on BETWEEN l.started_on AND l.started_on+COALESCE(s.max_milking_days,305)
      AND (l.ended_on IS NULL OR NEW.produced_on<=l.ended_on)) THEN
    RAISE EXCEPTION 'La producción no pertenece a una lactancia en ordeño vigente.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER milk_production_validate BEFORE INSERT ON milk_production
FOR EACH ROW EXECUTE FUNCTION validate_milk_production();

INSERT INTO media_entity_type_catalog(code,name) VALUES
  ('REPRODUCTION_HEAT','Celo'),('REPRODUCTION_SERVICE','Servicio reproductivo'),
  ('REPRODUCTION_PREGNANCY','Preñez'),('REPRODUCTION_BIRTH','Parto'),
  ('REPRODUCTION_LOSS','Pérdida de preñez'),('MILK_LACTATION','Lactancia'),
  ('MILK_PRODUCTION','Ordeño'),('MILK_TANK_PRODUCTION','Producción de tanque');

CREATE TRIGGER reproduction_service_no_delete BEFORE DELETE ON reproduction_service
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER milk_lactation_no_delete BEFORE DELETE ON milk_lactation
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER milk_production_no_delete BEFORE DELETE ON milk_production
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER milk_tank_no_delete BEFORE DELETE ON milk_tank_production
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

COMMIT;
