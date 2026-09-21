BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE property_status AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');
CREATE TYPE membership_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'ENDED');
CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
CREATE TYPE pay_frequency AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'OTHER');
CREATE TYPE module_scope AS ENUM ('ACCOUNT_PROPERTY', 'USER');

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name varchar(160) NOT NULL,
  status user_status NOT NULL DEFAULT 'PENDING',
  is_superadmin boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX one_active_superadmin
  ON app_user (is_superadmin)
  WHERE is_superadmin AND deleted_at IS NULL;

CREATE TABLE administrative_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES app_user(id),
  name varchar(160) NOT NULL,
  status account_status NOT NULL DEFAULT 'ACTIVE',
  max_properties integer NOT NULL DEFAULT 1 CHECK (max_properties >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE module_catalog (
  code varchar(60) PRIMARY KEY,
  name varchar(120) NOT NULL,
  description text,
  scope module_scope NOT NULL DEFAULT 'ACCOUNT_PROPERTY',
  is_core boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_module (
  account_id uuid NOT NULL REFERENCES administrative_account(id) ON DELETE CASCADE,
  module_code varchar(60) NOT NULL REFERENCES module_catalog(code),
  enabled boolean NOT NULL DEFAULT true,
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, module_code)
);

CREATE TABLE user_module (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  module_code varchar(60) NOT NULL REFERENCES module_catalog(code),
  enabled boolean NOT NULL DEFAULT true,
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_code)
);

CREATE TABLE property (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  owner_user_id uuid NOT NULL REFERENCES app_user(id),
  name varchar(160) NOT NULL,
  timezone varchar(80) NOT NULL DEFAULT 'America/Guayaquil',
  status property_status NOT NULL DEFAULT 'ACTIVE',
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX property_name_per_account
  ON property (account_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE TABLE property_module (
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  module_code varchar(60) NOT NULL REFERENCES module_catalog(code),
  enabled boolean NOT NULL DEFAULT true,
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, module_code)
);

CREATE TABLE property_membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  status membership_status NOT NULL DEFAULT 'INVITED',
  job_title varchar(140),
  joined_at timestamptz,
  ended_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, user_id)
);

CREATE TABLE property_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  code varchar(60) NOT NULL,
  name varchar(120) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

CREATE TABLE permission_catalog (
  code varchar(100) PRIMARY KEY,
  module_code varchar(60) REFERENCES module_catalog(code),
  name varchar(140) NOT NULL,
  description text
);

CREATE TABLE role_permission (
  role_id uuid NOT NULL REFERENCES property_role(id) ON DELETE CASCADE,
  permission_code varchar(100) NOT NULL REFERENCES permission_catalog(code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE membership_role (
  membership_id uuid NOT NULL REFERENCES property_membership(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES property_role(id) ON DELETE CASCADE,
  assigned_by uuid NOT NULL REFERENCES app_user(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id)
);

CREATE TABLE employment_term (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES property_membership(id) ON DELETE CASCADE,
  job_title varchar(140) NOT NULL,
  amount numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  frequency pay_frequency,
  valid_from date NOT NULL,
  valid_until date,
  notes text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX one_current_employment_term
  ON employment_term (membership_id)
  WHERE valid_until IS NULL;

CREATE TABLE property_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  email citext NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status invitation_status NOT NULL DEFAULT 'PENDING',
  invited_by uuid NOT NULL REFERENCES app_user(id),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES app_user(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_pending_invitation_per_property_email
  ON property_invitation (property_id, email)
  WHERE status = 'PENDING';

CREATE TABLE invitation_role (
  invitation_id uuid NOT NULL REFERENCES property_invitation(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES property_role(id) ON DELETE CASCADE,
  PRIMARY KEY (invitation_id, role_id)
);

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  device_id varchar(180),
  device_name varchar(180),
  active_property_id uuid REFERENCES property(id),
  active_role_id uuid REFERENCES property_role(id),
  ip_address inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES app_user(id),
  property_id uuid REFERENCES property(id),
  active_role_id uuid REFERENCES property_role(id),
  action varchar(120) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id text,
  reason text,
  before_data jsonb,
  after_data jsonb,
  superadmin_access boolean NOT NULL DEFAULT false,
  ip_address inet,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX membership_user_status_idx ON property_membership (user_id, status);
CREATE INDEX membership_property_status_idx ON property_membership (property_id, status);
CREATE INDEX audit_property_time_idx ON audit_event (property_id, occurred_at DESC);
CREATE INDEX audit_actor_time_idx ON audit_event (actor_user_id, occurred_at DESC);

CREATE FUNCTION validate_module_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_scope module_scope;
  actual_scope module_scope;
BEGIN
  expected_scope := TG_ARGV[0]::module_scope;

  SELECT scope INTO actual_scope
  FROM module_catalog
  WHERE code = NEW.module_code;

  IF actual_scope IS DISTINCT FROM expected_scope THEN
    RAISE EXCEPTION 'El módulo % no pertenece al ámbito %.', NEW.module_code, expected_scope
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER account_module_scope
BEFORE INSERT OR UPDATE OF module_code ON account_module
FOR EACH ROW EXECUTE FUNCTION validate_module_scope('ACCOUNT_PROPERTY');

CREATE TRIGGER property_module_scope
BEFORE INSERT OR UPDATE OF module_code ON property_module
FOR EACH ROW EXECUTE FUNCTION validate_module_scope('ACCOUNT_PROPERTY');

CREATE TRIGGER user_module_scope
BEFORE INSERT OR UPDATE OF module_code ON user_module
FOR EACH ROW EXECUTE FUNCTION validate_module_scope('USER');

INSERT INTO module_catalog(code, name, scope, is_core) VALUES
  ('CORE', 'Núcleo ganadero', 'ACCOUNT_PROPERTY', true),
  ('PRODUCTION', 'Producción', 'ACCOUNT_PROPERTY', false),
  ('WEIGHING', 'Pesajes', 'ACCOUNT_PROPERTY', false),
  ('PROPERTY_FINANCE', 'Ingresos y egresos', 'ACCOUNT_PROPERTY', false),
  ('PERSONAL_FINANCE', 'Mis finanzas', 'USER', false),
  ('OFFLINE', 'Contenido sin conexión', 'ACCOUNT_PROPERTY', false),
  ('REPRODUCTION', 'Reproducción', 'ACCOUNT_PROPERTY', false),
  ('MOVEMENTS', 'Movimientos', 'ACCOUNT_PROPERTY', false),
  ('HEALTH', 'Sanidad', 'ACCOUNT_PROPERTY', false),
  ('PASTURE_CLEANING', 'Limpieza de potreros', 'ACCOUNT_PROPERTY', false),
  ('SALES_PURCHASES', 'Ventas y compras', 'ACCOUNT_PROPERTY', false),
  ('TASKS', 'Tareas', 'ACCOUNT_PROPERTY', false),
  ('EVENTS', 'Eventos', 'ACCOUNT_PROPERTY', false),
  ('MULTIMEDIA', 'Multimedia', 'ACCOUNT_PROPERTY', false),
  ('PUBLIC_PROFILES', 'Fichas públicas', 'ACCOUNT_PROPERTY', false);

CREATE VIEW effective_property_module AS
SELECT
  p.id AS property_id,
  m.code AS module_code,
  CASE
    WHEN m.is_core THEN true
    ELSE coalesce(am.enabled, false) AND coalesce(pm.enabled, false)
  END AS enabled
FROM property p
CROSS JOIN module_catalog m
LEFT JOIN account_module am
  ON am.account_id = p.account_id
 AND am.module_code = m.code
LEFT JOIN property_module pm
  ON pm.property_id = p.id
 AND pm.module_code = m.code
WHERE m.scope = 'ACCOUNT_PROPERTY';

CREATE VIEW effective_user_module AS
SELECT
  u.id AS user_id,
  m.code AS module_code,
  coalesce(um.enabled, false) AS enabled
FROM app_user u
CROSS JOIN module_catalog m
LEFT JOIN user_module um
  ON um.user_id = u.id
 AND um.module_code = m.code
WHERE m.scope = 'USER';

CREATE FUNCTION enforce_property_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed integer;
  current_count integer;
BEGIN
  SELECT max_properties INTO allowed
  FROM administrative_account
  WHERE id = NEW.account_id
  FOR UPDATE;

  SELECT count(*) INTO current_count
  FROM property
  WHERE account_id = NEW.account_id
    AND deleted_at IS NULL
    AND status <> 'ARCHIVED';

  IF current_count >= allowed THEN
    RAISE EXCEPTION 'Se alcanzó el límite de propiedades permitido.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_limit_before_insert
BEFORE INSERT ON property
FOR EACH ROW EXECUTE FUNCTION enforce_property_limit();

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_user_touch_updated_at
BEFORE UPDATE ON app_user
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER administrative_account_touch_updated_at
BEFORE UPDATE ON administrative_account
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER property_touch_updated_at
BEFORE UPDATE ON property
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER property_membership_touch_updated_at
BEFORE UPDATE ON property_membership
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER property_role_touch_updated_at
BEFORE UPDATE ON property_role
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION protect_audit_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los eventos de auditoría son inmutables.' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER audit_event_immutable
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION protect_audit_event();

COMMIT;
