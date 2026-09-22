BEGIN;

CREATE TYPE quota_unit AS ENUM ('BYTES', 'COUNT');

CREATE TABLE quota_catalog (
  code varchar(60) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(140) NOT NULL,
  description text NOT NULL,
  unit quota_unit NOT NULL,
  default_limit bigint NOT NULL CHECK (default_limit >= 0),
  warning_percent smallint NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE account_quota (
  account_id uuid NOT NULL REFERENCES administrative_account(id) ON DELETE CASCADE,
  quota_code varchar(60) NOT NULL REFERENCES quota_catalog(code),
  limit_value bigint CHECK (limit_value IS NULL OR limit_value >= 0),
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, quota_code)
);

COMMENT ON COLUMN account_quota.limit_value IS
  'NULL significa sin límite. La ausencia de fila usa el valor predeterminado del catálogo.';

INSERT INTO quota_catalog(code, name, description, unit, default_limit) VALUES
  ('MEDIA_STORAGE_BYTES', 'Almacenamiento multimedia', 'Bytes de archivos originales conservados entre todas las propiedades de la cuenta.', 'BYTES', 2147483648),
  ('MANAGED_ANIMALS', 'Animales gestionados', 'Animales que todavía requieren gestión: activos, desaparecidos o inactivos temporalmente.', 'COUNT', 100),
  ('COLLABORATOR_USERS', 'Colaboradores', 'Personas únicas activas o invitadas entre todas las propiedades, sin contar al propietario.', 'COUNT', 10);

INSERT INTO account_quota(account_id, quota_code, limit_value)
SELECT a.id, q.code, q.default_limit
FROM administrative_account a
CROSS JOIN quota_catalog q
ON CONFLICT DO NOTHING;

CREATE FUNCTION seed_default_account_quotas() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_quota(account_id, quota_code, limit_value)
  SELECT NEW.id, code, default_limit
  FROM quota_catalog
  WHERE active;
  RETURN NEW;
END;
$$;

CREATE TRIGGER administrative_account_seed_quotas
AFTER INSERT ON administrative_account
FOR EACH ROW EXECUTE FUNCTION seed_default_account_quotas();

CREATE VIEW effective_account_quota AS
SELECT
  a.id AS account_id,
  q.code AS quota_code,
  q.name,
  q.unit,
  CASE WHEN aq.account_id IS NULL THEN q.default_limit ELSE aq.limit_value END AS limit_value,
  q.warning_percent
FROM administrative_account a
CROSS JOIN quota_catalog q
LEFT JOIN account_quota aq
  ON aq.account_id = a.id
 AND aq.quota_code = q.code
WHERE q.active;

CREATE VIEW account_collaborator_usage AS
WITH collaborator_email AS (
  SELECT p.account_id, lower(u.email::text) AS email
  FROM property p
  JOIN administrative_account a ON a.id = p.account_id
  JOIN property_membership pm ON pm.property_id = p.id
  JOIN app_user u ON u.id = pm.user_id
  WHERE p.deleted_at IS NULL
    AND p.status <> 'ARCHIVED'
    AND pm.status IN ('INVITED', 'ACTIVE')
    AND pm.user_id <> a.owner_user_id

  UNION

  SELECT p.account_id, lower(pi.email::text) AS email
  FROM property p
  JOIN administrative_account a ON a.id = p.account_id
  JOIN property_invitation pi ON pi.property_id = p.id
  JOIN app_user owner_user ON owner_user.id = a.owner_user_id
  WHERE p.deleted_at IS NULL
    AND p.status <> 'ARCHIVED'
    AND pi.status = 'PENDING'
    AND pi.expires_at > now()
    AND lower(pi.email::text) <> lower(owner_user.email::text)
)
SELECT a.id AS account_id, count(ce.email)::bigint AS used_value
FROM administrative_account a
LEFT JOIN collaborator_email ce ON ce.account_id = a.id
GROUP BY a.id;

CREATE TABLE animal_availability_status (
  code varchar(40) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(100) NOT NULL,
  description text NOT NULL,
  counts_toward_quota boolean NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE animal_exit_reason (
  code varchar(40) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(100) NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE sale_animal_effect (
  code varchar(50) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(120) NOT NULL,
  description text NOT NULL,
  requires_destination_property boolean NOT NULL DEFAULT false,
  results_in_exit boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE animal_status_transition (
  from_status varchar(40) NOT NULL REFERENCES animal_availability_status(code),
  to_status varchar(40) NOT NULL REFERENCES animal_availability_status(code),
  action_code varchar(60) NOT NULL CHECK (action_code = upper(action_code)),
  requires_reason boolean NOT NULL DEFAULT false,
  requires_source_reversal boolean NOT NULL DEFAULT false,
  PRIMARY KEY (from_status, to_status, action_code),
  CHECK (from_status <> to_status)
);

INSERT INTO catalog_definition(code, name, scope, mutability, module_code) VALUES
  ('ANIMAL_AVAILABILITY_STATUSES', 'Estados de disponibilidad del animal', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('ANIMAL_EXIT_REASONS', 'Motivos de salida del animal', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('SALE_ANIMAL_EFFECTS', 'Efectos de venta sobre el animal', 'PLATFORM', 'SYSTEM_ONLY', 'SALES_PURCHASES');

INSERT INTO animal_availability_status(code, name, description, counts_toward_quota, terminal) VALUES
  ('ACTIVE', 'Activo', 'Permanece bajo gestión y puede participar en operaciones compatibles.', true, false),
  ('MISSING', 'Desaparecido', 'No está localizado, pero continúa bajo gestión hasta resolver el caso.', true, false),
  ('INACTIVE', 'Inactivo temporal', 'Permanece registrado, pero no participa temporalmente en operaciones.', true, false),
  ('EXITED', 'Salió de la propiedad', 'Dejó la gestión por venta externa, donación, sacrificio o traslado externo.', false, false),
  ('DEAD', 'Muerto', 'Su ciclo de vida terminó y solo conserva historial.', false, true);

INSERT INTO animal_exit_reason(code, name, description) VALUES
  ('SALE', 'Venta externa', 'Salió como consecuencia de una venta fuera de las propiedades gestionadas.'),
  ('DONATION', 'Donación', 'Salió por una donación.'),
  ('SLAUGHTER', 'Sacrificio', 'Salió para sacrificio; si la muerte se registra antes, se utiliza el evento de muerte.'),
  ('EXTERNAL_TRANSFER', 'Traslado externo', 'Fue trasladado a una propiedad que no participa en el sistema.'),
  ('OTHER', 'Otro motivo', 'Salida justificada con una descripción obligatoria.');

INSERT INTO sale_animal_effect(
  code, name, description, requires_destination_property, results_in_exit
) VALUES
  ('KEEP_CURRENT_PROPERTY', 'Permanece en la propiedad', 'La venta se registra, pero el animal continúa activo en su ubicación actual.', false, false),
  ('EXIT_CURRENT_PROPERTY', 'Sale de la propiedad', 'Al confirmar la venta se cierra su ubicación y queda con estado de salida.', false, true),
  ('TRANSFER_TO_PROPERTY', 'Se transfiere a otra propiedad', 'Continúa activo y conserva historial al pasar a una propiedad destino autorizada.', true, false);

INSERT INTO animal_status_transition(
  from_status, to_status, action_code, requires_reason, requires_source_reversal
) VALUES
  ('ACTIVE', 'MISSING', 'REPORT_MISSING', true, false),
  ('MISSING', 'ACTIVE', 'MARK_FOUND', false, false),
  ('ACTIVE', 'INACTIVE', 'DEACTIVATE', true, false),
  ('INACTIVE', 'ACTIVE', 'REACTIVATE', false, false),
  ('ACTIVE', 'DEAD', 'RECORD_DEATH', true, false),
  ('MISSING', 'DEAD', 'RECORD_DEATH', true, false),
  ('INACTIVE', 'DEAD', 'RECORD_DEATH', true, false),
  ('ACTIVE', 'EXITED', 'RECORD_EXIT', true, false),
  ('MISSING', 'EXITED', 'RECORD_EXIT', true, false),
  ('INACTIVE', 'EXITED', 'RECORD_EXIT', true, false),
  ('EXITED', 'ACTIVE', 'REVERSE_EXIT', true, true);

COMMIT;
