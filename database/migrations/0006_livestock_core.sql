BEGIN;

CREATE TYPE animal_sex AS ENUM ('FEMALE', 'MALE');
CREATE TYPE record_lifecycle_status AS ENUM ('CURRENT', 'ARCHIVED', 'TRASHED', 'PURGED');
CREATE TYPE physical_location_kind AS ENUM ('PASTURE', 'CORRAL');
CREATE TYPE animal_parent_role AS ENUM ('MOTHER', 'FATHER');
CREATE TYPE property_party_kind AS ENUM ('USER', 'EXTERNAL_PERSON', 'ORGANIZATION');

INSERT INTO permission_catalog(code, module_code, name, description) VALUES
  ('ANIMAL_VIEW', 'CORE', 'Consultar animales', 'Consultar animales y su historial dentro de la propiedad.'),
  ('ANIMAL_CREATE', 'CORE', 'Registrar animales', 'Crear animales dentro de la propiedad activa.'),
  ('ANIMAL_UPDATE', 'CORE', 'Modificar animales', 'Modificar datos no destructivos y registrar cambios de estado.'),
  ('ANIMAL_ARCHIVE', 'CORE', 'Archivar animales', 'Archivar animales conservando todo su historial.'),
  ('ANIMAL_TRASH', 'CORE', 'Enviar animales a papelera', 'Enviar registros erróneos a la papelera recuperable.'),
  ('ANIMAL_RESTORE', 'CORE', 'Restaurar animales', 'Restaurar registros de animales antes de vencer su retención.'),
  ('ANIMAL_PURGE', 'CORE', 'Purgar animales', 'Purgar únicamente registros sin historial dependiente.'),
  ('GROUP_VIEW', 'CORE', 'Consultar grupos', 'Consultar grupos y sus integrantes.'),
  ('GROUP_MANAGE', 'CORE', 'Administrar grupos', 'Crear, modificar y archivar grupos.'),
  ('LOCATION_VIEW', 'CORE', 'Consultar ubicaciones', 'Consultar potreros, corrales y ocupación.'),
  ('LOCATION_MANAGE', 'CORE', 'Administrar ubicaciones', 'Crear, modificar y archivar potreros o corrales.');

INSERT INTO role_template_permission(role_code, permission_code)
SELECT 'OWNER', code
FROM permission_catalog
WHERE code IN (
  'ANIMAL_VIEW', 'ANIMAL_CREATE', 'ANIMAL_UPDATE', 'ANIMAL_ARCHIVE',
  'ANIMAL_TRASH', 'ANIMAL_RESTORE', 'ANIMAL_PURGE',
  'GROUP_VIEW', 'GROUP_MANAGE', 'LOCATION_VIEW', 'LOCATION_MANAGE'
);

INSERT INTO role_template_permission(role_code, permission_code)
SELECT 'ADMINISTRATOR', code
FROM permission_catalog
WHERE code IN (
  'ANIMAL_VIEW', 'ANIMAL_CREATE', 'ANIMAL_UPDATE', 'ANIMAL_ARCHIVE',
  'ANIMAL_TRASH', 'ANIMAL_RESTORE',
  'GROUP_VIEW', 'GROUP_MANAGE', 'LOCATION_VIEW', 'LOCATION_MANAGE'
);

INSERT INTO role_template_permission(role_code, permission_code)
SELECT 'OPERATOR', code
FROM permission_catalog
WHERE code IN (
  'ANIMAL_VIEW', 'ANIMAL_CREATE', 'ANIMAL_UPDATE', 'GROUP_VIEW', 'LOCATION_VIEW'
);

INSERT INTO role_template_permission(role_code, permission_code)
SELECT 'VIEWER', code
FROM permission_catalog
WHERE code IN ('ANIMAL_VIEW', 'GROUP_VIEW', 'LOCATION_VIEW');

INSERT INTO role_permission(role_id, permission_code)
SELECT pr.id, rtp.permission_code
FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code = pr.code
WHERE pr.is_system
ON CONFLICT DO NOTHING;

CREATE TABLE governed_catalog_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_code varchar(80) NOT NULL REFERENCES catalog_definition(code),
  account_id uuid REFERENCES administrative_account(id),
  property_id uuid,
  species_code varchar(30) REFERENCES species_catalog(code),
  item_code varchar(80) CHECK (item_code IS NULL OR item_code = upper(item_code)),
  name varchar(160) NOT NULL,
  description text,
  system_defined boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT governed_catalog_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CHECK (
    (system_defined AND account_id IS NULL AND property_id IS NULL)
    OR
    (NOT system_defined AND account_id IS NOT NULL AND property_id IS NOT NULL AND created_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX governed_system_catalog_code_unique
  ON governed_catalog_item (catalog_code, item_code)
  WHERE system_defined AND item_code IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX governed_property_catalog_name_unique
  ON governed_catalog_item (property_id, catalog_code, lower(name))
  WHERE NOT system_defined AND deleted_at IS NULL;

CREATE INDEX governed_catalog_lookup_idx
  ON governed_catalog_item (catalog_code, property_id, species_code, active)
  WHERE deleted_at IS NULL;

CREATE FUNCTION validate_governed_catalog_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  definition_scope catalog_scope;
  definition_mutability catalog_mutability;
BEGIN
  SELECT scope, mutability
    INTO definition_scope, definition_mutability
  FROM catalog_definition
  WHERE code = NEW.catalog_code AND active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El catálogo indicado no existe o está inactivo.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.system_defined THEN
    IF definition_mutability <> 'PROPERTY_EXTENSIBLE' THEN
      RAISE EXCEPTION 'Este catálogo no admite elementos predeterminados de plataforma.'
        USING ERRCODE = '23514';
    END IF;
  ELSIF definition_scope <> 'PROPERTY' OR definition_mutability = 'SYSTEM_ONLY' THEN
    RAISE EXCEPTION 'Este catálogo no admite elementos creados por una propiedad.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.species_code IS NOT NULL AND NOT NEW.system_defined AND NOT EXISTS (
    SELECT 1
    FROM effective_property_species eps
    WHERE eps.property_id = NEW.property_id
      AND eps.species_code = NEW.species_code
      AND eps.enabled
  ) THEN
    RAISE EXCEPTION 'La especie no está habilitada para esta propiedad.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER governed_catalog_item_validate
BEFORE INSERT OR UPDATE OF catalog_code, account_id, property_id, species_code, system_defined
ON governed_catalog_item
FOR EACH ROW EXECUTE FUNCTION validate_governed_catalog_item();

CREATE TRIGGER governed_catalog_item_touch_updated_at
BEFORE UPDATE ON governed_catalog_item
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER governed_catalog_item_no_direct_delete
BEFORE DELETE ON governed_catalog_item
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE animal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid NOT NULL,
  species_code varchar(30) NOT NULL REFERENCES species_catalog(code),
  ear_tag_code citext,
  name varchar(160) NOT NULL,
  description text,
  sex animal_sex NOT NULL,
  birth_date date,
  entry_date date NOT NULL DEFAULT current_date,
  origin_catalog_item_id uuid REFERENCES governed_catalog_item(id),
  initial_weight numeric(12,3) CHECK (initial_weight IS NULL OR initial_weight > 0),
  initial_weight_unit_code varchar(30) REFERENCES measurement_unit(code),
  availability_status_code varchar(40) NOT NULL DEFAULT 'ACTIVE'
    REFERENCES animal_availability_status(code),
  record_status record_lifecycle_status NOT NULL DEFAULT 'CURRENT',
  archived_at timestamptz,
  archived_by uuid REFERENCES app_user(id),
  trashed_at timestamptz,
  trashed_by uuid REFERENCES app_user(id),
  purge_after timestamptz,
  purged_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT animal_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CHECK (birth_date IS NULL OR entry_date >= birth_date),
  CHECK ((initial_weight IS NULL) = (initial_weight_unit_code IS NULL)),
  CHECK (record_status <> 'ARCHIVED' OR archived_at IS NOT NULL),
  CHECK (record_status <> 'TRASHED' OR (trashed_at IS NOT NULL AND purge_after IS NOT NULL)),
  CHECK (record_status <> 'PURGED' OR purged_at IS NOT NULL)
);

ALTER TABLE animal
  ADD CONSTRAINT animal_id_account_unique UNIQUE (id, account_id);

CREATE UNIQUE INDEX animal_tag_per_property_unique
  ON animal (property_id, lower(ear_tag_code::text))
  WHERE ear_tag_code IS NOT NULL AND record_status <> 'PURGED';

CREATE INDEX animal_property_status_idx
  ON animal (property_id, record_status, availability_status_code, name);

CREATE INDEX animal_account_quota_idx
  ON animal (account_id, availability_status_code)
  WHERE record_status = 'CURRENT';

CREATE FUNCTION validate_animal_context() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM effective_property_species eps
    WHERE eps.property_id = NEW.property_id
      AND eps.species_code = NEW.species_code
      AND eps.enabled
  ) THEN
    RAISE EXCEPTION 'La especie no está habilitada para esta propiedad.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.origin_catalog_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM governed_catalog_item ci
    WHERE ci.id = NEW.origin_catalog_item_id
      AND ci.catalog_code = 'ANIMAL_ORIGINS'
      AND ci.active
      AND ci.deleted_at IS NULL
      AND (ci.system_defined OR ci.property_id = NEW.property_id)
      AND (ci.species_code IS NULL OR ci.species_code = NEW.species_code)
  ) THEN
    RAISE EXCEPTION 'El origen seleccionado no es válido para este animal.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.initial_weight_unit_code IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM allowed_context_unit acu
    WHERE acu.context_code = 'ANIMAL_WEIGHT'
      AND acu.unit_code = NEW.initial_weight_unit_code
  ) THEN
    RAISE EXCEPTION 'La unidad indicada no puede utilizarse para el peso de un animal.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_validate_context
BEFORE INSERT OR UPDATE OF property_id, species_code, origin_catalog_item_id, initial_weight_unit_code
ON animal
FOR EACH ROW EXECUTE FUNCTION validate_animal_context();

CREATE FUNCTION enforce_managed_animal_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed bigint;
  current_count bigint;
  new_counts boolean;
  old_counts boolean := false;
BEGIN
  SELECT aas.counts_toward_quota AND NEW.record_status = 'CURRENT'
    INTO new_counts
  FROM animal_availability_status aas
  WHERE aas.code = NEW.availability_status_code;

  IF TG_OP = 'UPDATE' THEN
    SELECT aas.counts_toward_quota AND OLD.record_status = 'CURRENT'
      INTO old_counts
    FROM animal_availability_status aas
    WHERE aas.code = OLD.availability_status_code;
  END IF;

  IF NOT new_counts OR (old_counts AND NEW.account_id = OLD.account_id) THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM administrative_account WHERE id = NEW.account_id FOR UPDATE;

  SELECT limit_value INTO allowed
  FROM effective_account_quota
  WHERE account_id = NEW.account_id AND quota_code = 'MANAGED_ANIMALS';

  IF allowed IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO current_count
  FROM animal a
  JOIN animal_availability_status aas
    ON aas.code = a.availability_status_code
   AND aas.counts_toward_quota
  WHERE a.account_id = NEW.account_id
    AND a.record_status = 'CURRENT'
    AND a.id <> NEW.id;

  IF current_count >= allowed THEN
    RAISE EXCEPTION 'Se alcanzó el límite de animales gestionados de la cuenta.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_enforce_quota
BEFORE INSERT OR UPDATE OF account_id, availability_status_code, record_status
ON animal
FOR EACH ROW EXECUTE FUNCTION enforce_managed_animal_quota();

CREATE FUNCTION protect_animal_managed_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (
    NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.availability_status_code IS DISTINCT FROM OLD.availability_status_code
    OR NEW.record_status IS DISTINCT FROM OLD.record_status
  ) AND coalesce(current_setting('sgb.allow_animal_managed_write', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'La propiedad, el estado y el ciclo del animal cambian mediante operaciones de dominio.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_protect_managed_fields
BEFORE UPDATE OF account_id, property_id, availability_status_code, record_status
ON animal
FOR EACH ROW EXECUTE FUNCTION protect_animal_managed_fields();

CREATE FUNCTION touch_animal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_touch
BEFORE UPDATE ON animal
FOR EACH ROW EXECUTE FUNCTION touch_animal();

CREATE TRIGGER animal_no_direct_delete
BEFORE DELETE ON animal
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE VIEW account_managed_animal_usage AS
SELECT
  aa.id AS account_id,
  count(a.id) FILTER (
    WHERE a.record_status = 'CURRENT' AND aas.counts_toward_quota
  )::bigint AS used_value
FROM administrative_account aa
LEFT JOIN animal a ON a.account_id = aa.id
LEFT JOIN animal_availability_status aas
  ON aas.code = a.availability_status_code
GROUP BY aa.id;

CREATE TABLE animal_parentage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  child_animal_id uuid NOT NULL REFERENCES animal(id),
  role animal_parent_role NOT NULL,
  parent_animal_id uuid REFERENCES animal(id),
  reported_parent_name varchar(160),
  notes text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid REFERENCES app_user(id),
  removal_reason text,
  CHECK (
    (parent_animal_id IS NOT NULL AND reported_parent_name IS NULL)
    OR
    (parent_animal_id IS NULL AND reported_parent_name IS NOT NULL)
  ),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

CREATE UNIQUE INDEX animal_parentage_current_role_unique
  ON animal_parentage (child_animal_id, role)
  WHERE removed_at IS NULL;

CREATE INDEX animal_parentage_parent_idx
  ON animal_parentage (parent_animal_id)
  WHERE parent_animal_id IS NOT NULL AND removed_at IS NULL;

CREATE FUNCTION validate_animal_parentage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  child_record animal%ROWTYPE;
  parent_record animal%ROWTYPE;
BEGIN
  SELECT * INTO child_record FROM animal WHERE id = NEW.child_animal_id;
  IF NOT FOUND OR child_record.property_id <> NEW.property_id THEN
    RAISE EXCEPTION 'La cría no pertenece a la propiedad indicada.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_animal_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_animal_id = NEW.child_animal_id THEN
    RAISE EXCEPTION 'Un animal no puede ser su propio progenitor.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO parent_record FROM animal WHERE id = NEW.parent_animal_id;
  IF NOT FOUND
    OR parent_record.account_id <> child_record.account_id
    OR parent_record.species_code <> child_record.species_code
    OR parent_record.record_status IN ('TRASHED', 'PURGED') THEN
    RAISE EXCEPTION 'El progenitor no es válido para esta cría.'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.role = 'MOTHER' AND parent_record.sex <> 'FEMALE')
    OR (NEW.role = 'FATHER' AND parent_record.sex <> 'MALE') THEN
    RAISE EXCEPTION 'El sexo del progenitor no coincide con la relación indicada.'
      USING ERRCODE = '23514';
  END IF;

  IF child_record.birth_date IS NOT NULL
    AND parent_record.birth_date IS NOT NULL
    AND parent_record.birth_date >= child_record.birth_date THEN
    RAISE EXCEPTION 'El progenitor debe haber nacido antes que la cría.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors(animal_id) AS (
      SELECT NEW.parent_animal_id
      UNION
      SELECT ap.parent_animal_id
      FROM animal_parentage ap
      JOIN ancestors a ON a.animal_id = ap.child_animal_id
      WHERE ap.parent_animal_id IS NOT NULL AND ap.removed_at IS NULL
    )
    SELECT 1 FROM ancestors WHERE animal_id = NEW.child_animal_id
  ) THEN
    RAISE EXCEPTION 'La relación indicada produciría un ciclo de parentesco.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_parentage_validate
BEFORE INSERT OR UPDATE OF property_id, child_animal_id, role, parent_animal_id, removed_at
ON animal_parentage
FOR EACH ROW
WHEN (NEW.removed_at IS NULL)
EXECUTE FUNCTION validate_animal_parentage();

CREATE TRIGGER animal_parentage_no_direct_delete
BEFORE DELETE ON animal_parentage
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE property_party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid NOT NULL,
  kind property_party_kind NOT NULL,
  linked_user_id uuid REFERENCES app_user(id),
  display_name varchar(160) NOT NULL,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT property_party_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CHECK ((kind = 'USER') = (linked_user_id IS NOT NULL))
);

ALTER TABLE property_party
  ADD CONSTRAINT property_party_id_property_unique UNIQUE (id, property_id);

CREATE UNIQUE INDEX property_party_linked_user_unique
  ON property_party (property_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX property_party_name_idx
  ON property_party (property_id, lower(display_name))
  WHERE deleted_at IS NULL;

CREATE TRIGGER property_party_touch_updated_at
BEFORE UPDATE ON property_party
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER property_party_no_direct_delete
BEFORE DELETE ON property_party
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE animal_ownership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  animal_id uuid NOT NULL REFERENCES animal(id),
  party_id uuid NOT NULL,
  ownership_percent numeric(5,2) NOT NULL CHECK (ownership_percent > 0 AND ownership_percent <= 100),
  is_primary boolean NOT NULL DEFAULT false,
  valid_from date NOT NULL DEFAULT current_date,
  valid_until date,
  notes text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT animal_ownership_party_property_fk
    FOREIGN KEY (party_id, property_id)
    REFERENCES property_party(id, property_id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX animal_ownership_current_party_unique
  ON animal_ownership (animal_id, party_id)
  WHERE valid_until IS NULL;

CREATE UNIQUE INDEX animal_ownership_current_primary_unique
  ON animal_ownership (animal_id)
  WHERE valid_until IS NULL AND is_primary;

CREATE FUNCTION validate_animal_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_total numeric(7,2);
BEGIN
  PERFORM 1
  FROM animal
  WHERE id = NEW.animal_id AND property_id = NEW.property_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El animal no pertenece a la propiedad indicada.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.valid_until IS NULL THEN
    SELECT coalesce(sum(ownership_percent), 0)
      INTO current_total
    FROM animal_ownership
    WHERE animal_id = NEW.animal_id
      AND valid_until IS NULL
      AND id <> NEW.id;

    IF current_total + NEW.ownership_percent > 100 THEN
      RAISE EXCEPTION 'La participación total de propietarios no puede superar el 100 por ciento.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_ownership_validate
BEFORE INSERT OR UPDATE OF property_id, animal_id, party_id, ownership_percent, valid_until
ON animal_ownership
FOR EACH ROW EXECUTE FUNCTION validate_animal_ownership();

CREATE TRIGGER animal_ownership_no_direct_delete
BEFORE DELETE ON animal_ownership
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE livestock_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  group_type_catalog_item_id uuid REFERENCES governed_catalog_item(id),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES app_user(id),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT livestock_group_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CHECK (active OR archived_at IS NOT NULL)
);

ALTER TABLE livestock_group
  ADD CONSTRAINT livestock_group_id_property_unique UNIQUE (id, property_id);

CREATE UNIQUE INDEX livestock_group_name_unique
  ON livestock_group (property_id, lower(name))
  WHERE active;

CREATE FUNCTION validate_livestock_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_type_catalog_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM governed_catalog_item ci
    WHERE ci.id = NEW.group_type_catalog_item_id
      AND ci.catalog_code = 'GROUP_TYPES'
      AND ci.active
      AND ci.deleted_at IS NULL
      AND (ci.system_defined OR ci.property_id = NEW.property_id)
  ) THEN
    RAISE EXCEPTION 'El tipo de grupo no es válido para esta propiedad.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active AND EXISTS (
    SELECT 1 FROM animal_group_assignment aga
    WHERE aga.group_id = NEW.id AND aga.ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'No se puede archivar un grupo que todavía tiene animales.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION touch_livestock_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER livestock_group_touch
BEFORE UPDATE ON livestock_group
FOR EACH ROW EXECUTE FUNCTION touch_livestock_group();

CREATE TRIGGER livestock_group_no_direct_delete
BEFORE DELETE ON livestock_group
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE physical_location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid NOT NULL,
  kind physical_location_kind NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  area_value numeric(14,4) CHECK (area_value IS NULL OR area_value > 0),
  area_unit_code varchar(30) REFERENCES measurement_unit(code),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES app_user(id),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT physical_location_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CHECK ((area_value IS NULL) = (area_unit_code IS NULL)),
  CHECK (active OR archived_at IS NOT NULL)
);

ALTER TABLE physical_location
  ADD CONSTRAINT physical_location_id_property_unique UNIQUE (id, property_id);

CREATE UNIQUE INDEX physical_location_name_kind_unique
  ON physical_location (property_id, kind, lower(name))
  WHERE active;

CREATE FUNCTION validate_physical_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.area_unit_code IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM allowed_context_unit acu
    WHERE acu.context_code = 'LAND_AREA'
      AND acu.unit_code = NEW.area_unit_code
  ) THEN
    RAISE EXCEPTION 'La unidad indicada no puede utilizarse para el área de una ubicación.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active AND (
    EXISTS (
      SELECT 1 FROM animal_location_assignment ala
      WHERE ala.location_id = NEW.id AND ala.ended_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM group_location_assignment gla
      WHERE gla.location_id = NEW.id AND gla.ended_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'No se puede archivar una ubicación que todavía está ocupada.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION touch_physical_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER physical_location_touch
BEFORE UPDATE ON physical_location
FOR EACH ROW EXECUTE FUNCTION touch_physical_location();

CREATE TRIGGER physical_location_no_direct_delete
BEFORE DELETE ON physical_location
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TABLE animal_group_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  animal_id uuid NOT NULL REFERENCES animal(id),
  group_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  start_reason varchar(120) NOT NULL,
  end_reason varchar(120),
  movement_batch_id uuid,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT animal_group_assignment_group_property_fk
    FOREIGN KEY (group_id, property_id)
    REFERENCES livestock_group(id, property_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

CREATE UNIQUE INDEX animal_group_assignment_open_unique
  ON animal_group_assignment (animal_id)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX animal_group_assignment_batch_unique
  ON animal_group_assignment (animal_id, movement_batch_id)
  WHERE movement_batch_id IS NOT NULL;

CREATE INDEX animal_group_assignment_history_idx
  ON animal_group_assignment (animal_id, started_at DESC);

CREATE INDEX animal_group_assignment_current_group_idx
  ON animal_group_assignment (group_id)
  WHERE ended_at IS NULL;

CREATE TABLE animal_location_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  animal_id uuid NOT NULL REFERENCES animal(id),
  location_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  start_reason varchar(120) NOT NULL,
  end_reason varchar(120),
  movement_batch_id uuid,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT animal_location_assignment_location_property_fk
    FOREIGN KEY (location_id, property_id)
    REFERENCES physical_location(id, property_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

CREATE UNIQUE INDEX animal_location_assignment_open_unique
  ON animal_location_assignment (animal_id)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX animal_location_assignment_batch_unique
  ON animal_location_assignment (animal_id, movement_batch_id)
  WHERE movement_batch_id IS NOT NULL;

CREATE INDEX animal_location_assignment_history_idx
  ON animal_location_assignment (animal_id, started_at DESC);

CREATE INDEX animal_location_assignment_current_location_idx
  ON animal_location_assignment (location_id)
  WHERE ended_at IS NULL;

CREATE TABLE group_location_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  group_id uuid NOT NULL,
  location_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  start_reason varchar(120) NOT NULL,
  end_reason varchar(120),
  movement_batch_id uuid,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_location_assignment_group_property_fk
    FOREIGN KEY (group_id, property_id)
    REFERENCES livestock_group(id, property_id),
  CONSTRAINT group_location_assignment_location_property_fk
    FOREIGN KEY (location_id, property_id)
    REFERENCES physical_location(id, property_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

CREATE UNIQUE INDEX group_location_assignment_open_group_unique
  ON group_location_assignment (group_id)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX group_location_assignment_open_location_unique
  ON group_location_assignment (location_id)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX group_location_assignment_batch_unique
  ON group_location_assignment (group_id, movement_batch_id)
  WHERE movement_batch_id IS NOT NULL;

CREATE INDEX group_location_assignment_history_idx
  ON group_location_assignment (group_id, started_at DESC);

CREATE FUNCTION validate_animal_group_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  animal_record animal%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO animal_record
  FROM animal
  WHERE id = NEW.animal_id
  FOR UPDATE;

  IF NOT FOUND
    OR animal_record.property_id <> NEW.property_id
    OR animal_record.record_status <> 'CURRENT'
    OR animal_record.availability_status_code NOT IN ('ACTIVE', 'INACTIVE') THEN
    RAISE EXCEPTION 'El animal no está disponible para asignarlo a este grupo.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM livestock_group lg
    WHERE lg.id = NEW.group_id
      AND lg.property_id = NEW.property_id
      AND lg.active
  ) THEN
    RAISE EXCEPTION 'El grupo no está activo en la propiedad del animal.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM animal_group_assignment existing
    WHERE existing.animal_id = NEW.animal_id
      AND existing.id <> NEW.id
      AND tstzrange(existing.started_at, existing.ended_at, '[)')
          && tstzrange(NEW.started_at, NEW.ended_at, '[)')
  ) THEN
    RAISE EXCEPTION 'El animal ya tiene una asignación de grupo en ese intervalo.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_animal_location_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  animal_record animal%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO animal_record
  FROM animal
  WHERE id = NEW.animal_id
  FOR UPDATE;

  IF NOT FOUND
    OR animal_record.property_id <> NEW.property_id
    OR animal_record.record_status <> 'CURRENT'
    OR animal_record.availability_status_code NOT IN ('ACTIVE', 'INACTIVE') THEN
    RAISE EXCEPTION 'El animal no está disponible para asignarlo a esta ubicación.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM physical_location pl
    WHERE pl.id = NEW.location_id
      AND pl.property_id = NEW.property_id
      AND pl.active
  ) THEN
    RAISE EXCEPTION 'La ubicación no está activa en la propiedad del animal.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM animal_location_assignment existing
    WHERE existing.animal_id = NEW.animal_id
      AND existing.id <> NEW.id
      AND tstzrange(existing.started_at, existing.ended_at, '[)')
          && tstzrange(NEW.started_at, NEW.ended_at, '[)')
  ) THEN
    RAISE EXCEPTION 'El animal ya tiene una ubicación en ese intervalo.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_group_location_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM livestock_group WHERE id = NEW.group_id FOR UPDATE;
  PERFORM 1 FROM physical_location WHERE id = NEW.location_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM livestock_group lg
    WHERE lg.id = NEW.group_id AND lg.property_id = NEW.property_id AND lg.active
  ) OR NOT EXISTS (
    SELECT 1 FROM physical_location pl
    WHERE pl.id = NEW.location_id AND pl.property_id = NEW.property_id AND pl.active
  ) THEN
    RAISE EXCEPTION 'El grupo y la ubicación deben estar activos en la misma propiedad.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM group_location_assignment existing
    WHERE existing.id <> NEW.id
      AND (existing.group_id = NEW.group_id OR existing.location_id = NEW.location_id)
      AND tstzrange(existing.started_at, existing.ended_at, '[)')
          && tstzrange(NEW.started_at, NEW.ended_at, '[)')
  ) THEN
    RAISE EXCEPTION 'El grupo o la ubicación ya están ocupados en ese intervalo.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_group_assignment_validate
BEFORE INSERT OR UPDATE OF property_id, animal_id, group_id, started_at, ended_at
ON animal_group_assignment
FOR EACH ROW EXECUTE FUNCTION validate_animal_group_assignment();

CREATE TRIGGER animal_location_assignment_validate
BEFORE INSERT OR UPDATE OF property_id, animal_id, location_id, started_at, ended_at
ON animal_location_assignment
FOR EACH ROW EXECUTE FUNCTION validate_animal_location_assignment();

CREATE TRIGGER group_location_assignment_validate
BEFORE INSERT OR UPDATE OF property_id, group_id, location_id, started_at, ended_at
ON group_location_assignment
FOR EACH ROW EXECUTE FUNCTION validate_group_location_assignment();

CREATE FUNCTION protect_closed_interval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los intervalos históricos no se eliminan; se cierran o se revierten.'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'Un intervalo cerrado es inmutable.'
      USING ERRCODE = '23514';
  END IF;

  IF to_jsonb(NEW) - ARRAY['ended_at', 'end_reason']::text[]
      IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['ended_at', 'end_reason']::text[] THEN
    RAISE EXCEPTION 'Solo se permite cerrar un intervalo abierto.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ended_at IS NULL OR NEW.end_reason IS NULL THEN
    RAISE EXCEPTION 'Para cerrar un intervalo se requiere fecha y motivo.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER animal_group_assignment_immutable
BEFORE UPDATE OR DELETE ON animal_group_assignment
FOR EACH ROW EXECUTE FUNCTION protect_closed_interval();

CREATE TRIGGER animal_location_assignment_immutable
BEFORE UPDATE OR DELETE ON animal_location_assignment
FOR EACH ROW EXECUTE FUNCTION protect_closed_interval();

CREATE TRIGGER group_location_assignment_immutable
BEFORE UPDATE OR DELETE ON group_location_assignment
FOR EACH ROW EXECUTE FUNCTION protect_closed_interval();

CREATE TRIGGER livestock_group_validate
BEFORE INSERT OR UPDATE OF property_id, group_type_catalog_item_id, active
ON livestock_group
FOR EACH ROW EXECUTE FUNCTION validate_livestock_group();

CREATE TRIGGER physical_location_validate
BEFORE INSERT OR UPDATE OF area_unit_code, active
ON physical_location
FOR EACH ROW EXECUTE FUNCTION validate_physical_location();

CREATE VIEW animal_current_position AS
SELECT
  a.id AS animal_id,
  a.account_id,
  a.property_id,
  aga.group_id,
  lg.name AS group_name,
  aga.started_at AS group_started_at,
  ala.location_id,
  pl.kind AS location_kind,
  pl.name AS location_name,
  ala.started_at AS location_started_at
FROM animal a
LEFT JOIN animal_group_assignment aga
  ON aga.animal_id = a.id AND aga.ended_at IS NULL
LEFT JOIN livestock_group lg ON lg.id = aga.group_id
LEFT JOIN animal_location_assignment ala
  ON ala.animal_id = a.id AND ala.ended_at IS NULL
LEFT JOIN physical_location pl ON pl.id = ala.location_id
WHERE a.record_status = 'CURRENT';

CREATE VIEW physical_location_occupancy AS
SELECT
  pl.id AS location_id,
  pl.account_id,
  pl.property_id,
  pl.kind,
  pl.name,
  count(a.id)::bigint AS occupant_count,
  min(ala.started_at) FILTER (WHERE a.id IS NOT NULL) AS occupied_since
FROM physical_location pl
LEFT JOIN animal_location_assignment ala
  ON ala.location_id = pl.id
 AND ala.ended_at IS NULL
LEFT JOIN animal a
  ON a.id = ala.animal_id
 AND a.record_status = 'CURRENT'
 AND a.availability_status_code IN ('ACTIVE', 'INACTIVE')
GROUP BY pl.id, pl.account_id, pl.property_id, pl.kind, pl.name;

CREATE VIEW livestock_group_current_members AS
SELECT
  lg.id AS group_id,
  lg.account_id,
  lg.property_id,
  count(a.id)::bigint AS animal_count,
  min(aga.started_at) FILTER (WHERE a.id IS NOT NULL) AS oldest_assignment_at
FROM livestock_group lg
LEFT JOIN animal_group_assignment aga
  ON aga.group_id = lg.id
 AND aga.ended_at IS NULL
LEFT JOIN animal a
  ON a.id = aga.animal_id
 AND a.record_status = 'CURRENT'
 AND a.availability_status_code IN ('ACTIVE', 'INACTIVE')
GROUP BY lg.id, lg.account_id, lg.property_id;

CREATE TABLE animal_status_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  animal_id uuid NOT NULL REFERENCES animal(id),
  from_status varchar(40) NOT NULL REFERENCES animal_availability_status(code),
  to_status varchar(40) NOT NULL REFERENCES animal_availability_status(code),
  action_code varchar(60) NOT NULL CHECK (action_code = upper(action_code)),
  exit_reason_code varchar(40) REFERENCES animal_exit_reason(code),
  reason text,
  occurred_at timestamptz NOT NULL,
  reversal_of uuid REFERENCES animal_status_event(id),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status <> to_status)
);

CREATE UNIQUE INDEX animal_status_event_reversal_unique
  ON animal_status_event (reversal_of)
  WHERE reversal_of IS NOT NULL;

CREATE INDEX animal_status_event_history_idx
  ON animal_status_event (animal_id, occurred_at DESC, created_at DESC);

CREATE FUNCTION protect_animal_status_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
    AND coalesce(current_setting('sgb.allow_animal_status_event', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Los eventos de estado son inmutables y se crean mediante operaciones de dominio.'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER animal_status_event_protected
BEFORE INSERT OR UPDATE OR DELETE ON animal_status_event
FOR EACH ROW EXECUTE FUNCTION protect_animal_status_event();

ALTER TABLE media_attachment
  ADD COLUMN deleted_by uuid REFERENCES app_user(id),
  ADD COLUMN deletion_reason text,
  ADD COLUMN deletion_operation_id uuid;

CREATE INDEX media_attachment_deletion_operation_idx
  ON media_attachment (deletion_operation_id)
  WHERE deletion_operation_id IS NOT NULL;

ALTER TABLE entity_tombstone
  ADD COLUMN trash_operation_id uuid,
  ADD COLUMN restored_at timestamptz,
  ADD COLUMN restored_by uuid REFERENCES app_user(id);

CREATE UNIQUE INDEX entity_tombstone_account_operation_unique
  ON entity_tombstone (account_id, trash_operation_id)
  WHERE trash_operation_id IS NOT NULL;

CREATE FUNCTION user_has_property_permission(
  p_user_id uuid,
  p_property_id uuid,
  p_role_id uuid,
  p_permission_code varchar
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM app_user u
      WHERE u.id = p_user_id
        AND u.is_superadmin
        AND u.status = 'ACTIVE'
        AND u.deleted_at IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM property_membership pm
      JOIN membership_role mr
        ON mr.membership_id = pm.id
       AND mr.property_id = pm.property_id
      JOIN property_role pr
        ON pr.id = mr.role_id
       AND pr.property_id = pm.property_id
      JOIN role_permission rp ON rp.role_id = pr.id
      WHERE pm.user_id = p_user_id
        AND pm.property_id = p_property_id
        AND pm.status = 'ACTIVE'
        AND pr.id = p_role_id
        AND pr.active
        AND rp.permission_code = p_permission_code
    );
$$;

CREATE FUNCTION change_animal_status(
  p_animal_id uuid,
  p_actor_user_id uuid,
  p_active_role_id uuid,
  p_to_status varchar,
  p_action_code varchar,
  p_reason text,
  p_exit_reason_code varchar,
  p_occurred_at timestamptz,
  p_reversal_of uuid,
  p_expected_version bigint
) RETURNS animal
LANGUAGE plpgsql AS $$
DECLARE
  animal_before animal%ROWTYPE;
  animal_after animal%ROWTYPE;
  transition_rule animal_status_transition%ROWTYPE;
  effective_time timestamptz := coalesce(p_occurred_at, now());
  actor_is_superadmin boolean;
BEGIN
  SELECT * INTO animal_before
  FROM animal
  WHERE id = p_animal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El animal no existe.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT user_has_property_permission(
    p_actor_user_id, animal_before.property_id, p_active_role_id, 'ANIMAL_UPDATE'
  ) THEN
    RAISE EXCEPTION 'No tiene permiso para cambiar el estado del animal.'
      USING ERRCODE = '42501';
  END IF;

  IF animal_before.version <> p_expected_version THEN
    RAISE EXCEPTION 'El animal cambió desde la última lectura; actualice los datos antes de continuar.'
      USING ERRCODE = '40001';
  END IF;

  IF animal_before.record_status <> 'CURRENT' THEN
    RAISE EXCEPTION 'El estado de un animal archivado o en papelera no puede modificarse.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO transition_rule
  FROM animal_status_transition
  WHERE from_status = animal_before.availability_status_code
    AND to_status = upper(p_to_status)
    AND action_code = upper(p_action_code);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La transición de estado solicitada no está permitida.'
      USING ERRCODE = '23514';
  END IF;

  IF transition_rule.requires_reason AND nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'La transición requiere un motivo.'
      USING ERRCODE = '23514';
  END IF;

  IF upper(p_to_status) = 'EXITED' THEN
    IF p_exit_reason_code IS NULL OR NOT EXISTS (
      SELECT 1 FROM animal_exit_reason
      WHERE code = upper(p_exit_reason_code) AND active
    ) THEN
      RAISE EXCEPTION 'La salida requiere un motivo válido.'
        USING ERRCODE = '23514';
    END IF;
  ELSIF p_exit_reason_code IS NOT NULL THEN
    RAISE EXCEPTION 'El motivo de salida solo aplica cuando el animal sale de la propiedad.'
      USING ERRCODE = '23514';
  END IF;

  IF transition_rule.requires_source_reversal THEN
    IF p_reversal_of IS NULL OR NOT EXISTS (
      SELECT 1 FROM animal_status_event ase
      WHERE ase.id = p_reversal_of
        AND ase.animal_id = p_animal_id
        AND ase.to_status = animal_before.availability_status_code
    ) THEN
      RAISE EXCEPTION 'La reversión debe señalar el evento original compatible.'
        USING ERRCODE = '23514';
    END IF;
  ELSIF p_reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'Esta transición no admite un evento de reversión.'
      USING ERRCODE = '23514';
  END IF;

  IF effective_time > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'La fecha del cambio de estado no puede estar en el futuro.'
      USING ERRCODE = '22007';
  END IF;

  IF upper(p_to_status) IN ('MISSING', 'EXITED', 'DEAD') AND (
    EXISTS (
      SELECT 1 FROM animal_group_assignment
      WHERE animal_id = p_animal_id AND ended_at IS NULL AND started_at > effective_time
    )
    OR EXISTS (
      SELECT 1 FROM animal_location_assignment
      WHERE animal_id = p_animal_id AND ended_at IS NULL AND started_at > effective_time
    )
  ) THEN
    RAISE EXCEPTION 'Existen movimientos posteriores; deben corregirse antes de registrar este estado.'
      USING ERRCODE = '23514';
  END IF;

  IF upper(p_to_status) IN ('MISSING', 'EXITED', 'DEAD') THEN
    UPDATE animal_group_assignment
    SET ended_at = effective_time, end_reason = upper(p_action_code)
    WHERE animal_id = p_animal_id AND ended_at IS NULL;

    UPDATE animal_location_assignment
    SET ended_at = effective_time, end_reason = upper(p_action_code)
    WHERE animal_id = p_animal_id AND ended_at IS NULL;
  END IF;

  PERFORM set_config('sgb.allow_animal_status_event', 'on', true);
  INSERT INTO animal_status_event(
    property_id, animal_id, from_status, to_status, action_code,
    exit_reason_code, reason, occurred_at, reversal_of, created_by
  ) VALUES (
    animal_before.property_id,
    p_animal_id,
    animal_before.availability_status_code,
    upper(p_to_status),
    upper(p_action_code),
    CASE WHEN p_exit_reason_code IS NULL THEN NULL ELSE upper(p_exit_reason_code) END,
    nullif(btrim(p_reason), ''),
    effective_time,
    p_reversal_of,
    p_actor_user_id
  );
  PERFORM set_config('sgb.allow_animal_status_event', 'off', true);

  PERFORM set_config('sgb.allow_animal_managed_write', 'on', true);
  UPDATE animal
  SET availability_status_code = upper(p_to_status),
      updated_by = p_actor_user_id
  WHERE id = p_animal_id
  RETURNING * INTO animal_after;
  PERFORM set_config('sgb.allow_animal_managed_write', 'off', true);

  SELECT is_superadmin INTO actor_is_superadmin
  FROM app_user WHERE id = p_actor_user_id;

  INSERT INTO audit_event(
    actor_user_id, property_id, active_role_id, action,
    entity_type, entity_id, reason, before_data, after_data, superadmin_access
  ) VALUES (
    p_actor_user_id,
    animal_before.property_id,
    p_active_role_id,
    upper(p_action_code),
    'ANIMAL',
    p_animal_id::text,
    nullif(btrim(p_reason), ''),
    to_jsonb(animal_before),
    to_jsonb(animal_after),
    coalesce(actor_is_superadmin, false)
  );

  RETURN animal_after;
END;
$$;

CREATE FUNCTION move_animal_to_trash(
  p_animal_id uuid,
  p_actor_user_id uuid,
  p_active_role_id uuid,
  p_reason text,
  p_operation_id uuid,
  p_expected_version bigint
) RETURNS animal
LANGUAGE plpgsql AS $$
DECLARE
  animal_before animal%ROWTYPE;
  animal_after animal%ROWTYPE;
  retention_days smallint;
  effective_time timestamptz := now();
  effective_purge_after timestamptz;
  current_group_id uuid;
  current_location_id uuid;
  actor_is_superadmin boolean;
BEGIN
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Enviar un animal a papelera requiere un motivo.'
      USING ERRCODE = '23514';
  END IF;

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'La operación requiere una clave idempotente.'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO animal_before
  FROM animal
  WHERE id = p_animal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El animal no existe.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT user_has_property_permission(
    p_actor_user_id, animal_before.property_id, p_active_role_id, 'ANIMAL_TRASH'
  ) THEN
    RAISE EXCEPTION 'No tiene permiso para enviar este animal a la papelera.'
      USING ERRCODE = '42501';
  END IF;

  IF animal_before.record_status = 'TRASHED' THEN
    RETURN animal_before;
  END IF;

  IF animal_before.record_status = 'PURGED' THEN
    RAISE EXCEPTION 'Un registro purgado no puede volver a enviarse a papelera.'
      USING ERRCODE = '23514';
  END IF;

  IF animal_before.version <> p_expected_version THEN
    RAISE EXCEPTION 'El animal cambió desde la última lectura; actualice los datos antes de continuar.'
      USING ERRCODE = '40001';
  END IF;

  SELECT arp.retention_days INTO retention_days
  FROM account_retention_policy arp
  WHERE arp.account_id = animal_before.account_id
    AND arp.policy_code = 'ANIMAL_TRASH';

  retention_days := coalesce(retention_days, 30);
  effective_purge_after := effective_time + make_interval(days => retention_days);

  SELECT group_id INTO current_group_id
  FROM animal_group_assignment
  WHERE animal_id = p_animal_id AND ended_at IS NULL;

  SELECT location_id INTO current_location_id
  FROM animal_location_assignment
  WHERE animal_id = p_animal_id AND ended_at IS NULL;

  UPDATE animal_group_assignment
  SET ended_at = effective_time, end_reason = 'MOVED_TO_TRASH'
  WHERE animal_id = p_animal_id AND ended_at IS NULL;

  UPDATE animal_location_assignment
  SET ended_at = effective_time, end_reason = 'MOVED_TO_TRASH'
  WHERE animal_id = p_animal_id AND ended_at IS NULL;

  UPDATE media_attachment
  SET deleted_at = effective_time,
      deleted_by = p_actor_user_id,
      deletion_reason = 'ANIMAL_MOVED_TO_TRASH',
      deletion_operation_id = p_operation_id
  WHERE entity_type = 'ANIMAL'
    AND entity_id = p_animal_id
    AND deleted_at IS NULL;

  UPDATE storage_object so
  SET status = 'TRASHED',
      trashed_at = effective_time,
      purge_after = effective_purge_after
  WHERE so.id IN (
    SELECT ma.storage_object_id
    FROM media_attachment ma
    WHERE ma.entity_type = 'ANIMAL'
      AND ma.entity_id = p_animal_id
      AND ma.deletion_operation_id = p_operation_id
  )
    AND so.status NOT IN ('TRASHED', 'DELETE_PENDING', 'PURGED')
    AND NOT EXISTS (
      SELECT 1 FROM media_attachment active_reference
      WHERE active_reference.storage_object_id = so.id
        AND active_reference.deleted_at IS NULL
    );

  INSERT INTO entity_tombstone(
    account_id, property_id, entity_type, entity_id, display_label,
    snapshot, reason, trashed_by, trashed_at, purge_after,
    trash_operation_id, restored_at, restored_by, purged_at
  ) VALUES (
    animal_before.account_id,
    animal_before.property_id,
    'ANIMAL',
    animal_before.id,
    coalesce(animal_before.ear_tag_code::text || ' · ', '') || animal_before.name,
    jsonb_build_object(
      'animal', to_jsonb(animal_before),
      'group_id', current_group_id,
      'location_id', current_location_id
    ),
    btrim(p_reason),
    p_actor_user_id,
    effective_time,
    effective_purge_after,
    p_operation_id,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET account_id = EXCLUDED.account_id,
      property_id = EXCLUDED.property_id,
      display_label = EXCLUDED.display_label,
      snapshot = EXCLUDED.snapshot,
      reason = EXCLUDED.reason,
      trashed_by = EXCLUDED.trashed_by,
      trashed_at = EXCLUDED.trashed_at,
      purge_after = EXCLUDED.purge_after,
      trash_operation_id = EXCLUDED.trash_operation_id,
      restored_at = NULL,
      restored_by = NULL,
      purged_at = NULL;

  PERFORM set_config('sgb.allow_animal_managed_write', 'on', true);
  UPDATE animal
  SET record_status = 'TRASHED',
      trashed_at = effective_time,
      trashed_by = p_actor_user_id,
      purge_after = effective_purge_after,
      updated_by = p_actor_user_id
  WHERE id = p_animal_id
  RETURNING * INTO animal_after;
  PERFORM set_config('sgb.allow_animal_managed_write', 'off', true);

  SELECT is_superadmin INTO actor_is_superadmin
  FROM app_user WHERE id = p_actor_user_id;

  INSERT INTO audit_event(
    actor_user_id, property_id, active_role_id, action,
    entity_type, entity_id, reason, before_data, after_data, superadmin_access
  ) VALUES (
    p_actor_user_id,
    animal_before.property_id,
    p_active_role_id,
    'ANIMAL_MOVED_TO_TRASH',
    'ANIMAL',
    p_animal_id::text,
    btrim(p_reason),
    to_jsonb(animal_before),
    to_jsonb(animal_after),
    coalesce(actor_is_superadmin, false)
  );

  RETURN animal_after;
END;
$$;

CREATE FUNCTION restore_animal_from_trash(
  p_animal_id uuid,
  p_actor_user_id uuid,
  p_active_role_id uuid,
  p_reason text,
  p_expected_version bigint
) RETURNS animal
LANGUAGE plpgsql AS $$
DECLARE
  animal_before animal%ROWTYPE;
  animal_after animal%ROWTYPE;
  tombstone_record entity_tombstone%ROWTYPE;
  previous_record_status record_lifecycle_status;
  actor_is_superadmin boolean;
BEGIN
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Restaurar un animal requiere un motivo.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO animal_before
  FROM animal
  WHERE id = p_animal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El animal no existe.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT user_has_property_permission(
    p_actor_user_id, animal_before.property_id, p_active_role_id, 'ANIMAL_RESTORE'
  ) THEN
    RAISE EXCEPTION 'No tiene permiso para restaurar este animal.'
      USING ERRCODE = '42501';
  END IF;

  IF animal_before.record_status <> 'TRASHED' THEN
    RAISE EXCEPTION 'El animal no se encuentra en la papelera.'
      USING ERRCODE = '23514';
  END IF;

  IF animal_before.version <> p_expected_version THEN
    RAISE EXCEPTION 'El animal cambió desde la última lectura; actualice los datos antes de continuar.'
      USING ERRCODE = '40001';
  END IF;

  SELECT * INTO tombstone_record
  FROM entity_tombstone
  WHERE entity_type = 'ANIMAL' AND entity_id = p_animal_id
  FOR UPDATE;

  IF NOT FOUND OR tombstone_record.purge_after <= now() THEN
    RAISE EXCEPTION 'El plazo de restauración del animal ya venció.'
      USING ERRCODE = '23514';
  END IF;

  previous_record_status := coalesce(
    (tombstone_record.snapshot #>> '{animal,record_status}')::record_lifecycle_status,
    'CURRENT'::record_lifecycle_status
  );

  IF previous_record_status IN ('TRASHED', 'PURGED') THEN
    previous_record_status := 'CURRENT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM media_attachment ma
    JOIN storage_object so ON so.id = ma.storage_object_id
    WHERE ma.entity_type = 'ANIMAL'
      AND ma.entity_id = p_animal_id
      AND ma.deletion_operation_id = tombstone_record.trash_operation_id
      AND so.status IN ('DELETE_PENDING', 'PURGED')
  ) THEN
    RAISE EXCEPTION 'La multimedia del animal ya inició su eliminación y no puede restaurarse automáticamente.'
      USING ERRCODE = '23514';
  END IF;

  UPDATE storage_object so
  SET status = 'AVAILABLE',
      trashed_at = NULL,
      purge_after = NULL
  WHERE so.id IN (
    SELECT ma.storage_object_id
    FROM media_attachment ma
    WHERE ma.entity_type = 'ANIMAL'
      AND ma.entity_id = p_animal_id
      AND ma.deletion_operation_id = tombstone_record.trash_operation_id
  )
    AND so.status = 'TRASHED';

  UPDATE media_attachment
  SET deleted_at = NULL,
      deleted_by = NULL,
      deletion_reason = NULL,
      deletion_operation_id = NULL
  WHERE entity_type = 'ANIMAL'
    AND entity_id = p_animal_id
    AND deletion_operation_id = tombstone_record.trash_operation_id;

  PERFORM set_config('sgb.allow_animal_managed_write', 'on', true);
  UPDATE animal
  SET record_status = previous_record_status,
      trashed_at = NULL,
      trashed_by = NULL,
      purge_after = NULL,
      updated_by = p_actor_user_id
  WHERE id = p_animal_id
  RETURNING * INTO animal_after;
  PERFORM set_config('sgb.allow_animal_managed_write', 'off', true);

  UPDATE entity_tombstone
  SET restored_at = now(), restored_by = p_actor_user_id
  WHERE id = tombstone_record.id;

  SELECT is_superadmin INTO actor_is_superadmin
  FROM app_user WHERE id = p_actor_user_id;

  INSERT INTO audit_event(
    actor_user_id, property_id, active_role_id, action,
    entity_type, entity_id, reason, before_data, after_data, superadmin_access
  ) VALUES (
    p_actor_user_id,
    animal_before.property_id,
    p_active_role_id,
    'ANIMAL_RESTORED',
    'ANIMAL',
    p_animal_id::text,
    btrim(p_reason),
    to_jsonb(animal_before),
    to_jsonb(animal_after),
    coalesce(actor_is_superadmin, false)
  );

  RETURN animal_after;
END;
$$;

COMMENT ON FUNCTION restore_animal_from_trash(uuid, uuid, uuid, text, bigint) IS
  'Restaura perfil y multimedia. Grupo y ubicación se reasignan de forma explícita para no reabrir una ocupación obsoleta.';

COMMIT;
