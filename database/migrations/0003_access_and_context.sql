BEGIN;

ALTER TABLE app_user
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until timestamptz;

ALTER TABLE user_session
  ADD COLUMN access_token_hash text NOT NULL UNIQUE,
  ADD COLUMN access_expires_at timestamptz NOT NULL;

CREATE UNIQUE INDEX one_live_session_per_device
  ON user_session (user_id, device_id)
  WHERE revoked_at IS NULL AND device_id IS NOT NULL;

CREATE TABLE email_verification_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_user_idx
  ON email_verification_token (user_id, created_at DESC);

CREATE TABLE password_reset_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_template (
  code varchar(60) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(120) NOT NULL,
  description text,
  sort_order smallint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE role_template_permission (
  role_code varchar(60) NOT NULL REFERENCES role_template(code) ON DELETE CASCADE,
  permission_code varchar(100) NOT NULL REFERENCES permission_catalog(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

INSERT INTO permission_catalog(code, module_code, name, description) VALUES
  ('PROPERTY_VIEW', 'CORE', 'Consultar propiedad', 'Consultar información general de la propiedad.'),
  ('PROPERTY_UPDATE', 'CORE', 'Modificar propiedad', 'Modificar información y configuración no destructiva.'),
  ('PROPERTY_ARCHIVE', 'CORE', 'Archivar propiedad', 'Archivar una propiedad sin borrar su historial.'),
  ('PROPERTY_TRANSFER', 'CORE', 'Transferir propiedad', 'Transferir la propiedad a otra persona.'),
  ('MEMBERSHIP_VIEW', 'CORE', 'Consultar colaboradores', 'Consultar membresías, cargos y roles.'),
  ('MEMBERSHIP_MANAGE', 'CORE', 'Administrar colaboradores', 'Invitar, suspender o finalizar membresías.'),
  ('ROLE_VIEW', 'CORE', 'Consultar roles', 'Consultar roles y permisos.'),
  ('ROLE_MANAGE', 'CORE', 'Administrar roles', 'Crear roles locales y asignar permisos permitidos.'),
  ('MODULE_VIEW', 'CORE', 'Consultar módulos', 'Consultar módulos disponibles y activos.'),
  ('MODULE_MANAGE', 'CORE', 'Administrar módulos', 'Desactivar o reactivar módulos permitidos.'),
  ('AUDIT_VIEW', 'CORE', 'Consultar auditoría', 'Consultar el historial de acciones de la propiedad.'),
  ('CATALOG_VIEW', 'CORE', 'Consultar catálogos', 'Consultar catálogos disponibles.'),
  ('CATALOG_MANAGE', 'CORE', 'Administrar catálogos', 'Administrar catálogos propios de la propiedad.');

INSERT INTO role_template(code, name, description, sort_order) VALUES
  ('OWNER', 'Propietario', 'Control total y exclusivo de las decisiones de propiedad.', 10),
  ('ADMINISTRATOR', 'Administrador', 'Administra la operación sin transferir ni archivar la propiedad.', 20),
  ('OPERATOR', 'Operador', 'Ejecuta actividades autorizadas y consulta lo necesario.', 30),
  ('VIEWER', 'Consulta', 'Acceso de solo lectura a la información autorizada.', 40);

INSERT INTO role_template_permission(role_code, permission_code)
SELECT 'OWNER', code FROM permission_catalog;

INSERT INTO role_template_permission(role_code, permission_code)
SELECT 'ADMINISTRATOR', code
FROM permission_catalog
WHERE code NOT IN ('PROPERTY_ARCHIVE', 'PROPERTY_TRANSFER');

INSERT INTO role_template_permission(role_code, permission_code) VALUES
  ('OPERATOR', 'PROPERTY_VIEW'),
  ('OPERATOR', 'MEMBERSHIP_VIEW'),
  ('OPERATOR', 'MODULE_VIEW'),
  ('OPERATOR', 'CATALOG_VIEW'),
  ('VIEWER', 'PROPERTY_VIEW'),
  ('VIEWER', 'MODULE_VIEW'),
  ('VIEWER', 'CATALOG_VIEW');

ALTER TABLE property_membership
  ADD CONSTRAINT property_membership_id_property_unique UNIQUE (id, property_id);

ALTER TABLE property_role
  ADD CONSTRAINT property_role_id_property_unique UNIQUE (id, property_id);

ALTER TABLE property_invitation
  ADD CONSTRAINT property_invitation_id_property_unique UNIQUE (id, property_id);

ALTER TABLE membership_role
  ADD COLUMN property_id uuid;

UPDATE membership_role mr
SET property_id = pm.property_id
FROM property_membership pm
WHERE pm.id = mr.membership_id;

ALTER TABLE membership_role
  ALTER COLUMN property_id SET NOT NULL,
  ADD CONSTRAINT membership_role_membership_property_fk
    FOREIGN KEY (membership_id, property_id)
    REFERENCES property_membership(id, property_id) ON DELETE CASCADE,
  ADD CONSTRAINT membership_role_role_property_fk
    FOREIGN KEY (role_id, property_id)
    REFERENCES property_role(id, property_id) ON DELETE CASCADE;

ALTER TABLE invitation_role
  ADD COLUMN property_id uuid;

UPDATE invitation_role ir
SET property_id = pi.property_id
FROM property_invitation pi
WHERE pi.id = ir.invitation_id;

ALTER TABLE invitation_role
  ALTER COLUMN property_id SET NOT NULL,
  ADD CONSTRAINT invitation_role_invitation_property_fk
    FOREIGN KEY (invitation_id, property_id)
    REFERENCES property_invitation(id, property_id) ON DELETE CASCADE,
  ADD CONSTRAINT invitation_role_role_property_fk
    FOREIGN KEY (role_id, property_id)
    REFERENCES property_role(id, property_id) ON DELETE CASCADE;

CREATE FUNCTION validate_session_context() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_property_id IS NULL AND NEW.active_role_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.active_property_id IS NULL OR NEW.active_role_id IS NULL THEN
    RAISE EXCEPTION 'La propiedad y el rol activos deben establecerse juntos.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM property_membership pm
    JOIN membership_role mr
      ON mr.membership_id = pm.id
     AND mr.property_id = pm.property_id
    JOIN property_role pr
      ON pr.id = mr.role_id
     AND pr.property_id = pm.property_id
    WHERE pm.user_id = NEW.user_id
      AND pm.property_id = NEW.active_property_id
      AND pm.status = 'ACTIVE'
      AND pr.id = NEW.active_role_id
      AND pr.active
  ) THEN
    RAISE EXCEPTION 'El contexto activo no pertenece al usuario.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER user_session_validate_context
BEFORE INSERT OR UPDATE OF user_id, active_property_id, active_role_id ON user_session
FOR EACH ROW EXECUTE FUNCTION validate_session_context();

COMMIT;
