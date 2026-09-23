BEGIN;

-- Adapted from lafortuna's celo/prenez/parto model. All references now use the
-- SGB account and property boundaries, with historical rows retained.
INSERT INTO permission_catalog(code, module_code, name, description) VALUES
  ('REPRODUCTION_VIEW', 'REPRODUCTION', 'Consultar reproducción', 'Consultar celos, preñeces y partos de la propiedad.'),
  ('REPRODUCTION_MANAGE', 'REPRODUCTION', 'Registrar reproducción', 'Registrar y finalizar eventos reproductivos.');

INSERT INTO role_template_permission(role_code, permission_code)
SELECT rt.code, pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code = 'REPRODUCTION_VIEW' OR
  (pc.code = 'REPRODUCTION_MANAGE' AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));

INSERT INTO role_permission(role_id, permission_code)
SELECT pr.id, rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code = pr.code
WHERE pr.is_system AND rtp.permission_code IN ('REPRODUCTION_VIEW','REPRODUCTION_MANAGE')
ON CONFLICT DO NOTHING;

CREATE TABLE reproduction_setting (
  property_id uuid PRIMARY KEY REFERENCES property(id),
  days_after_birth_heat integer NOT NULL DEFAULT 30 CHECK(days_after_birth_heat BETWEEN 0 AND 365),
  days_after_birth_pregnancy integer NOT NULL DEFAULT 45 CHECK(days_after_birth_pregnancy BETWEEN 0 AND 365),
  days_after_loss_heat integer NOT NULL DEFAULT 21 CHECK(days_after_loss_heat BETWEEN 0 AND 365),
  days_after_loss_pregnancy integer NOT NULL DEFAULT 30 CHECK(days_after_loss_pregnancy BETWEEN 0 AND 365),
  minimum_cow_months integer NOT NULL DEFAULT 12 CHECK(minimum_cow_months BETWEEN 0 AND 120),
  minimum_bull_months integer NOT NULL DEFAULT 12 CHECK(minimum_bull_months BETWEEN 0 AND 120),
  allow_second_heat boolean NOT NULL DEFAULT true,
  allow_false_heat_in_pregnancy boolean NOT NULL DEFAULT true,
  use_last_valid_heat boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reproduction_heat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  cow_id uuid NOT NULL REFERENCES animal(id),
  bull_id uuid REFERENCES animal(id),
  starts_on date NOT NULL,
  ends_on date,
  is_false boolean NOT NULL DEFAULT false,
  notes varchar(500),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES app_user(id),
  FOREIGN KEY(property_id, account_id) REFERENCES property(id, account_id),
  CHECK(ends_on IS NULL OR ends_on >= starts_on),
  CHECK((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE UNIQUE INDEX reproduction_heat_one_per_day
  ON reproduction_heat(cow_id, starts_on) WHERE cancelled_at IS NULL;
CREATE INDEX reproduction_heat_property_date ON reproduction_heat(property_id, starts_on DESC);

CREATE TABLE reproduction_pregnancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  cow_id uuid NOT NULL REFERENCES animal(id),
  heat_id uuid REFERENCES reproduction_heat(id),
  father_id uuid REFERENCES animal(id),
  external_father varchar(240),
  conception_method varchar(40) NOT NULL CHECK(conception_method IN
    ('NATURAL','INSEMINATION','EMBRYO_TRANSFER','UNKNOWN')),
  confirmation_method varchar(40) NOT NULL CHECK(confirmation_method IN
    ('PALPATION','ULTRASOUND','BLOOD_TEST','OBSERVATION','OTHER')),
  confirmed_on date NOT NULL,
  gestation_days integer CHECK(gestation_days BETWEEN 0 AND 400),
  conception_on date,
  expected_birth_on date,
  status varchar(20) NOT NULL DEFAULT 'CONFIRMED'
    CHECK(status IN ('CONFIRMED','BORN','LOST','CANCELLED')),
  notes varchar(500),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES app_user(id),
  FOREIGN KEY(property_id, account_id) REFERENCES property(id, account_id),
  CHECK(father_id IS NULL OR external_father IS NULL),
  CHECK((status = 'CONFIRMED') = (resolved_at IS NULL AND resolved_by IS NULL))
);
CREATE UNIQUE INDEX reproduction_one_active_pregnancy
  ON reproduction_pregnancy(cow_id) WHERE status = 'CONFIRMED';
CREATE INDEX reproduction_pregnancy_property_date
  ON reproduction_pregnancy(property_id, confirmed_on DESC);

CREATE TABLE reproduction_birth (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  pregnancy_id uuid NOT NULL UNIQUE REFERENCES reproduction_pregnancy(id),
  mother_id uuid NOT NULL REFERENCES animal(id),
  occurred_on date NOT NULL,
  live_count integer NOT NULL CHECK(live_count >= 0),
  stillborn_count integer NOT NULL CHECK(stillborn_count >= 0),
  notes text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id, account_id) REFERENCES property(id, account_id),
  CHECK(live_count + stillborn_count > 0)
);
CREATE INDEX reproduction_birth_property_date ON reproduction_birth(property_id, occurred_on DESC);

CREATE TABLE reproduction_birth_calf (
  birth_id uuid NOT NULL REFERENCES reproduction_birth(id),
  animal_id uuid NOT NULL UNIQUE REFERENCES animal(id),
  PRIMARY KEY(birth_id, animal_id)
);

CREATE TABLE reproduction_loss (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  pregnancy_id uuid NOT NULL UNIQUE REFERENCES reproduction_pregnancy(id),
  cow_id uuid NOT NULL REFERENCES animal(id),
  occurred_on date NOT NULL,
  notes text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id, account_id) REFERENCES property(id, account_id)
);

CREATE FUNCTION validate_reproduction_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cow_record animal%ROWTYPE; father_record animal%ROWTYPE; event_cow_id uuid; event_father_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'reproduction_birth' OR TG_TABLE_NAME = 'reproduction_loss' THEN
    IF TG_TABLE_NAME = 'reproduction_birth' THEN
      event_cow_id := NEW.mother_id;
    ELSE
      event_cow_id := NEW.cow_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM reproduction_pregnancy p
      WHERE p.id = NEW.pregnancy_id AND p.account_id = NEW.account_id
        AND p.property_id = NEW.property_id
        AND p.cow_id = event_cow_id AND p.status = 'CONFIRMED'
        AND NEW.occurred_on >= p.confirmed_on) THEN
      RAISE EXCEPTION 'La preñez no corresponde a esta vaca y propiedad.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO cow_record FROM animal WHERE id = NEW.cow_id;
  IF NOT FOUND OR cow_record.account_id <> NEW.account_id OR cow_record.property_id <> NEW.property_id
    OR cow_record.sex <> 'FEMALE' OR cow_record.record_status <> 'CURRENT'
    OR cow_record.availability_status_code <> 'ACTIVE' THEN
    RAISE EXCEPTION 'La vaca debe estar activa en esta propiedad.' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'reproduction_heat' THEN
    event_father_id := NEW.bull_id;
  ELSE
    IF NEW.heat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reproduction_heat h
       WHERE h.id = NEW.heat_id AND h.cow_id = NEW.cow_id
         AND h.property_id = NEW.property_id AND h.cancelled_at IS NULL
         AND NOT h.is_false AND h.starts_on <= NEW.confirmed_on) THEN
      RAISE EXCEPTION 'El celo no corresponde a esta preñez.' USING ERRCODE = '23514';
    END IF;
    event_father_id := NEW.father_id;
  END IF;
  IF event_father_id IS NOT NULL THEN
    SELECT * INTO father_record FROM animal WHERE id = event_father_id;
    IF father_record.account_id IS DISTINCT FROM NEW.account_id
       OR father_record.sex <> 'MALE' OR father_record.record_status <> 'CURRENT' THEN
      RAISE EXCEPTION 'El padre no está disponible en esta cuenta.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reproduction_heat_scope BEFORE INSERT ON reproduction_heat
FOR EACH ROW EXECUTE FUNCTION validate_reproduction_scope();
CREATE TRIGGER reproduction_pregnancy_scope BEFORE INSERT ON reproduction_pregnancy
FOR EACH ROW EXECUTE FUNCTION validate_reproduction_scope();
CREATE TRIGGER reproduction_birth_scope BEFORE INSERT ON reproduction_birth
FOR EACH ROW EXECUTE FUNCTION validate_reproduction_scope();
CREATE TRIGGER reproduction_loss_scope BEFORE INSERT ON reproduction_loss
FOR EACH ROW EXECUTE FUNCTION validate_reproduction_scope();

-- Birth and calf linkage must remain coherent even for administrative writes.
CREATE FUNCTION validate_reproduction_calf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reproduction_birth b JOIN animal a ON a.id = NEW.animal_id
    WHERE b.id = NEW.birth_id AND a.account_id = b.account_id
      AND a.property_id = b.property_id AND a.sex IN ('FEMALE','MALE')
      AND a.birth_date = b.occurred_on) THEN
    RAISE EXCEPTION 'La cría debe corresponder al parto y su propiedad.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reproduction_calf_scope BEFORE INSERT ON reproduction_birth_calf
FOR EACH ROW EXECUTE FUNCTION validate_reproduction_calf();

CREATE TRIGGER reproduction_heat_no_delete BEFORE DELETE ON reproduction_heat
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER reproduction_pregnancy_no_delete BEFORE DELETE ON reproduction_pregnancy
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER reproduction_birth_no_delete BEFORE DELETE ON reproduction_birth
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER reproduction_calf_no_delete BEFORE DELETE ON reproduction_birth_calf
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE TRIGGER reproduction_loss_no_delete BEFORE DELETE ON reproduction_loss
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

COMMIT;
