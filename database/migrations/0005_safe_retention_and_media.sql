BEGIN;

CREATE TYPE media_kind AS ENUM ('IMAGE', 'VIDEO');
CREATE TYPE storage_object_status AS ENUM (
  'PENDING_UPLOAD',
  'PROCESSING',
  'AVAILABLE',
  'QUARANTINED',
  'TRASHED',
  'DELETE_PENDING',
  'PURGED',
  'FAILED'
);
CREATE TYPE deletion_job_status AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'FAILED');
CREATE TYPE quota_reservation_status AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED');

ALTER TABLE property
  ADD CONSTRAINT property_id_account_unique UNIQUE (id, account_id);

CREATE TABLE retention_policy_catalog (
  code varchar(60) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(140) NOT NULL,
  default_days smallint NOT NULL CHECK (default_days BETWEEN 0 AND 3650),
  description text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE account_retention_policy (
  account_id uuid NOT NULL REFERENCES administrative_account(id) ON DELETE CASCADE,
  policy_code varchar(60) NOT NULL REFERENCES retention_policy_catalog(code),
  retention_days smallint NOT NULL CHECK (retention_days BETWEEN 0 AND 3650),
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, policy_code)
);

INSERT INTO retention_policy_catalog(code, name, default_days, description) VALUES
  ('ANIMAL_TRASH', 'Papelera de animales', 30, 'Tiempo para restaurar un registro erróneo antes de evaluar su purga.'),
  ('MEDIA_TRASH', 'Papelera multimedia', 30, 'Tiempo para restaurar un archivo antes de eliminarlo del proveedor.');

INSERT INTO account_retention_policy(account_id, policy_code, retention_days)
SELECT a.id, p.code, p.default_days
FROM administrative_account a
CROSS JOIN retention_policy_catalog p
ON CONFLICT DO NOTHING;

CREATE FUNCTION seed_default_retention_policies() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_retention_policy(account_id, policy_code, retention_days)
  SELECT NEW.id, code, default_days
  FROM retention_policy_catalog
  WHERE active;
  RETURN NEW;
END;
$$;

CREATE TRIGGER administrative_account_seed_retention
AFTER INSERT ON administrative_account
FOR EACH ROW EXECUTE FUNCTION seed_default_retention_policies();

CREATE TABLE media_entity_type_catalog (
  code varchar(60) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(120) NOT NULL,
  active boolean NOT NULL DEFAULT true
);

INSERT INTO media_entity_type_catalog(code, name) VALUES
  ('ANIMAL', 'Animal'),
  ('PROPERTY', 'Propiedad'),
  ('USER_PROFILE', 'Perfil de usuario'),
  ('HEALTH_EVENT', 'Evento sanitario'),
  ('MOVEMENT', 'Movimiento'),
  ('CLEANING', 'Limpieza de potrero'),
  ('TASK', 'Tarea'),
  ('EVENT', 'Evento');

CREATE TABLE storage_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  origin_property_id uuid,
  provider varchar(60) NOT NULL,
  provider_asset_id text,
  storage_key text NOT NULL UNIQUE,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  kind media_kind NOT NULL,
  mime_type varchar(120) NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms > 0),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status storage_object_status NOT NULL DEFAULT 'PENDING_UPLOAD',
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  purge_after timestamptz,
  purged_at timestamptz,
  failure_reason text,
  CONSTRAINT storage_object_origin_property_fk
    FOREIGN KEY (origin_property_id, account_id)
    REFERENCES property(id, account_id),
  CHECK (kind = 'IMAGE' OR duration_ms IS NOT NULL),
  CHECK (status <> 'TRASHED' OR (trashed_at IS NOT NULL AND purge_after IS NOT NULL)),
  CHECK (status <> 'PURGED' OR purged_at IS NOT NULL)
);

ALTER TABLE storage_object
  ADD CONSTRAINT storage_object_id_account_unique UNIQUE (id, account_id);

CREATE UNIQUE INDEX storage_provider_asset_unique
  ON storage_object (provider, provider_asset_id)
  WHERE provider_asset_id IS NOT NULL AND status <> 'PURGED';

CREATE UNIQUE INDEX storage_account_content_unique
  ON storage_object (account_id, sha256, byte_size)
  WHERE status IN ('PROCESSING', 'AVAILABLE', 'TRASHED', 'DELETE_PENDING');

CREATE INDEX storage_purge_due_idx
  ON storage_object (purge_after)
  WHERE status = 'TRASHED';

CREATE TABLE media_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  storage_object_id uuid NOT NULL,
  property_id uuid NOT NULL,
  entity_type varchar(60) NOT NULL REFERENCES media_entity_type_catalog(code),
  entity_id uuid NOT NULL,
  relation_code varchar(60) NOT NULL CHECK (relation_code = upper(relation_code)),
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT media_attachment_storage_account_fk
    FOREIGN KEY (storage_object_id, account_id)
    REFERENCES storage_object(id, account_id),
  CONSTRAINT media_attachment_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id)
);

CREATE UNIQUE INDEX media_attachment_active_unique
  ON media_attachment (storage_object_id, entity_type, entity_id, relation_code)
  WHERE deleted_at IS NULL;

CREATE INDEX media_attachment_entity_idx
  ON media_attachment (entity_type, entity_id, deleted_at);

CREATE TABLE storage_deletion_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_object_id uuid NOT NULL UNIQUE REFERENCES storage_object(id),
  status deletion_job_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(180),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);

CREATE INDEX storage_deletion_job_ready_idx
  ON storage_deletion_job (next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'RETRY');

CREATE TABLE media_quota_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
  status quota_reservation_status NOT NULL DEFAULT 'RESERVED',
  storage_object_id uuid,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT media_reservation_property_account_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  CONSTRAINT media_reservation_storage_account_fk
    FOREIGN KEY (storage_object_id, account_id)
    REFERENCES storage_object(id, account_id),
  UNIQUE (account_id, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (status <> 'CONSUMED' OR (storage_object_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status NOT IN ('RELEASED', 'EXPIRED') OR completed_at IS NOT NULL)
);

CREATE UNIQUE INDEX media_reservation_storage_unique
  ON media_quota_reservation (storage_object_id)
  WHERE storage_object_id IS NOT NULL;

CREATE INDEX media_reservation_expiry_idx
  ON media_quota_reservation (expires_at)
  WHERE status = 'RESERVED';

CREATE TABLE entity_tombstone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  property_id uuid,
  entity_type varchar(60) NOT NULL CHECK (entity_type = upper(entity_type)),
  entity_id uuid NOT NULL,
  display_label varchar(200) NOT NULL,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  trashed_by uuid NOT NULL REFERENCES app_user(id),
  trashed_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  purged_at timestamptz,
  CONSTRAINT entity_tombstone_property_fk
    FOREIGN KEY (property_id, account_id)
    REFERENCES property(id, account_id),
  UNIQUE (entity_type, entity_id)
);

CREATE INDEX entity_tombstone_purge_due_idx
  ON entity_tombstone (purge_after)
  WHERE purged_at IS NULL;

CREATE VIEW account_media_storage_usage AS
SELECT
  a.id AS account_id,
  coalesce(sum(so.byte_size) FILTER (
    WHERE so.status IN ('AVAILABLE', 'QUARANTINED', 'TRASHED', 'DELETE_PENDING')
  ), 0)::bigint AS used_value
FROM administrative_account a
LEFT JOIN storage_object so ON so.account_id = a.id
GROUP BY a.id;

CREATE VIEW account_media_storage_commitment AS
SELECT
  a.id AS account_id,
  coalesce(u.used_value, 0)::bigint AS stored_bytes,
  coalesce(sum(r.reserved_bytes) FILTER (
    WHERE r.status = 'RESERVED' AND r.expires_at > now()
  ), 0)::bigint AS reserved_bytes,
  (
    coalesce(u.used_value, 0)
    + coalesce(sum(r.reserved_bytes) FILTER (
        WHERE r.status = 'RESERVED' AND r.expires_at > now()
      ), 0)
  )::bigint AS committed_bytes
FROM administrative_account a
LEFT JOIN account_media_storage_usage u ON u.account_id = a.id
LEFT JOIN media_quota_reservation r ON r.account_id = a.id
GROUP BY a.id, u.used_value;

CREATE FUNCTION queue_storage_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'DELETE_PENDING' AND OLD.status IS DISTINCT FROM 'DELETE_PENDING' THEN
    INSERT INTO storage_deletion_job(storage_object_id)
    VALUES(NEW.id)
    ON CONFLICT (storage_object_id) DO UPDATE
      SET status = 'PENDING',
          next_attempt_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          completed_at = NULL,
          updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_storage_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PURGED' THEN
    RAISE EXCEPTION 'Un archivo purgado no puede volver a cambiar de estado.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'DELETE_PENDING' THEN
    IF OLD.status <> 'TRASHED' THEN
      RAISE EXCEPTION 'Un archivo debe pasar por la papelera antes de solicitar su eliminación.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.purge_after IS NULL OR NEW.purge_after > now() THEN
      RAISE EXCEPTION 'El plazo recuperable del archivo todavía no ha vencido.'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1 FROM media_attachment
      WHERE storage_object_id = NEW.id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'No se puede eliminar un archivo que todavía tiene referencias activas.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'PURGED' AND OLD.status <> 'DELETE_PENDING' THEN
    RAISE EXCEPTION 'Un archivo solo puede purgarse después de solicitar su eliminación al proveedor.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_object_validate_transition
BEFORE UPDATE OF status ON storage_object
FOR EACH ROW EXECUTE FUNCTION validate_storage_transition();

CREATE TRIGGER storage_object_queue_deletion
AFTER UPDATE OF status ON storage_object
FOR EACH ROW EXECUTE FUNCTION queue_storage_deletion();

CREATE FUNCTION validate_storage_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'PURGED' AND OLD.status IS DISTINCT FROM 'PURGED' THEN
    IF EXISTS (
      SELECT 1 FROM media_attachment
      WHERE storage_object_id = NEW.id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'No se puede purgar un archivo que todavía tiene referencias activas.'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM storage_deletion_job
      WHERE storage_object_id = NEW.id AND status = 'COMPLETED'
    ) THEN
      RAISE EXCEPTION 'El proveedor todavía no confirmó la eliminación del archivo.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_object_validate_purge
BEFORE UPDATE OF status ON storage_object
FOR EACH ROW EXECUTE FUNCTION validate_storage_purge();

CREATE FUNCTION prevent_managed_record_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Este registro administrado cambia de estado y no se elimina directamente con DELETE.'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER storage_object_no_direct_delete
BEFORE DELETE ON storage_object
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TRIGGER media_attachment_no_direct_delete
BEFORE DELETE ON media_attachment
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TRIGGER entity_tombstone_no_direct_delete
BEFORE DELETE ON entity_tombstone
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

CREATE TRIGGER storage_object_touch_updated_at
BEFORE UPDATE ON storage_object
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER storage_deletion_job_touch_updated_at
BEFORE UPDATE ON storage_deletion_job
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
