BEGIN;

CREATE TYPE catalog_scope AS ENUM ('PLATFORM', 'PROPERTY', 'USER');
CREATE TYPE catalog_mutability AS ENUM ('SYSTEM_ONLY', 'PROPERTY_EXTENSIBLE', 'PROPERTY_ONLY');
CREATE TYPE measurement_dimension AS ENUM ('MASS', 'VOLUME', 'AREA', 'LENGTH', 'COUNT');

CREATE TABLE catalog_definition (
  code varchar(80) PRIMARY KEY,
  name varchar(140) NOT NULL,
  scope catalog_scope NOT NULL,
  mutability catalog_mutability NOT NULL,
  module_code varchar(60) REFERENCES module_catalog(code),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE species_catalog (
  code varchar(30) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(100) NOT NULL UNIQUE,
  ruleset_code varchar(60) NOT NULL UNIQUE,
  ruleset_version integer NOT NULL DEFAULT 1 CHECK (ruleset_version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capability_catalog (
  code varchar(60) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(140) NOT NULL,
  module_code varchar(60) REFERENCES module_catalog(code),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE species_capability (
  species_code varchar(30) NOT NULL REFERENCES species_catalog(code),
  capability_code varchar(60) NOT NULL REFERENCES capability_catalog(code),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (species_code, capability_code)
);

CREATE TABLE account_species (
  account_id uuid NOT NULL REFERENCES administrative_account(id) ON DELETE CASCADE,
  species_code varchar(30) NOT NULL REFERENCES species_catalog(code),
  enabled boolean NOT NULL DEFAULT false,
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, species_code)
);

CREATE TABLE property_species (
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  species_code varchar(30) NOT NULL REFERENCES species_catalog(code),
  enabled boolean NOT NULL DEFAULT false,
  configured_by uuid REFERENCES app_user(id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, species_code)
);

CREATE TABLE measurement_unit (
  code varchar(30) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(100) NOT NULL UNIQUE,
  symbol varchar(20) NOT NULL,
  dimension measurement_dimension NOT NULL,
  factor_to_base numeric(24,12) NOT NULL CHECK (factor_to_base > 0),
  decimal_places smallint NOT NULL DEFAULT 2 CHECK (decimal_places BETWEEN 0 AND 6),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unit_usage_context (
  code varchar(60) PRIMARY KEY CHECK (code = upper(code)),
  name varchar(140) NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE allowed_context_unit (
  context_code varchar(60) NOT NULL REFERENCES unit_usage_context(code),
  unit_code varchar(30) NOT NULL REFERENCES measurement_unit(code),
  is_default boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (context_code, unit_code)
);

CREATE UNIQUE INDEX one_default_unit_per_context
  ON allowed_context_unit (context_code)
  WHERE is_default;

INSERT INTO catalog_definition(code, name, scope, mutability, module_code) VALUES
  ('SPECIES', 'Especies', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('MEASUREMENT_UNITS', 'Unidades de medida', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('UNIT_CONTEXTS', 'Uso permitido de unidades', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('ANIMAL_SEXES', 'Sexos', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('ANIMAL_STATUSES', 'Estados del animal', 'PLATFORM', 'SYSTEM_ONLY', 'CORE'),
  ('ADMINISTRATION_ROUTES', 'Vías de administración', 'PLATFORM', 'SYSTEM_ONLY', 'HEALTH'),
  ('PAYMENT_METHODS', 'Métodos de pago', 'PLATFORM', 'SYSTEM_ONLY', 'PROPERTY_FINANCE'),
  ('BREEDS', 'Razas', 'PROPERTY', 'PROPERTY_EXTENSIBLE', 'CORE'),
  ('COLORS', 'Colores', 'PROPERTY', 'PROPERTY_EXTENSIBLE', 'CORE'),
  ('ANIMAL_ORIGINS', 'Orígenes', 'PROPERTY', 'PROPERTY_ONLY', 'CORE'),
  ('GROUP_TYPES', 'Tipos de grupo', 'PROPERTY', 'PROPERTY_ONLY', 'CORE'),
  ('GRASS_TYPES', 'Tipos de pasto', 'PROPERTY', 'PROPERTY_ONLY', 'CORE'),
  ('PASTURE_USE_TYPES', 'Usos de potrero', 'PROPERTY', 'PROPERTY_ONLY', 'CORE'),
  ('CORRAL_TYPES', 'Tipos de corral', 'PROPERTY', 'PROPERTY_ONLY', 'CORE'),
  ('CLEANING_TYPES', 'Tipos de limpieza', 'PROPERTY', 'PROPERTY_ONLY', 'PASTURE_CLEANING'),
  ('MOVEMENT_REASONS', 'Motivos de movimiento', 'PROPERTY', 'PROPERTY_ONLY', 'MOVEMENTS'),
  ('AGROCHEMICAL_CATEGORIES', 'Categorías de agroquímicos', 'PROPERTY', 'PROPERTY_ONLY', 'PASTURE_CLEANING'),
  ('AGROCHEMICALS', 'Agroquímicos', 'PROPERTY', 'PROPERTY_ONLY', 'PASTURE_CLEANING'),
  ('TREATMENT_TYPES', 'Tipos de tratamiento', 'PROPERTY', 'PROPERTY_ONLY', 'HEALTH'),
  ('MEDICINES', 'Medicamentos', 'PROPERTY', 'PROPERTY_ONLY', 'HEALTH'),
  ('SALE_PRODUCTS', 'Productos de venta', 'PROPERTY', 'PROPERTY_ONLY', 'SALES_PURCHASES'),
  ('BUYERS', 'Compradores', 'PROPERTY', 'PROPERTY_ONLY', 'SALES_PURCHASES'),
  ('MEDIA_TAGS', 'Etiquetas multimedia', 'PROPERTY', 'PROPERTY_ONLY', 'MULTIMEDIA'),
  ('PURCHASE_PRODUCT_TYPES', 'Tipos de producto de compra', 'PROPERTY', 'PROPERTY_ONLY', 'SALES_PURCHASES'),
  ('ACTIVITY_TYPES', 'Tipos de actividad', 'PROPERTY', 'PROPERTY_ONLY', 'TASKS'),
  ('HEALTH_CONDITION_TYPES', 'Condiciones de salud', 'PROPERTY', 'PROPERTY_ONLY', 'HEALTH'),
  ('PRODUCT_PRESENTATIONS', 'Presentaciones de productos', 'PROPERTY', 'PROPERTY_ONLY', 'SALES_PURCHASES');

INSERT INTO species_catalog(code, name, ruleset_code) VALUES
  ('BOVINE', 'Bovino', 'BOVINE_V1');

INSERT INTO capability_catalog(code, name, module_code) VALUES
  ('ANIMAL_REGISTRATION', 'Registro de animales', 'CORE'),
  ('GROUP_ASSIGNMENT', 'Asignación a grupos', 'CORE'),
  ('LOCATION_ASSIGNMENT', 'Asignación a potreros o corrales', 'CORE'),
  ('MOVEMENT', 'Movimientos', 'MOVEMENTS'),
  ('WEIGHING', 'Pesajes', 'WEIGHING'),
  ('HEALTH_TREATMENT', 'Tratamientos sanitarios', 'HEALTH'),
  ('MILK_PRODUCTION', 'Producción de leche', 'PRODUCTION'),
  ('REPRODUCTION', 'Reproducción', 'REPRODUCTION'),
  ('BRANDING', 'Herraje', 'TASKS'),
  ('DEHORNING', 'Descorne', 'TASKS');

INSERT INTO species_capability(species_code, capability_code)
SELECT 'BOVINE', code FROM capability_catalog;

INSERT INTO measurement_unit(code, name, symbol, dimension, factor_to_base, decimal_places) VALUES
  ('MILLIGRAM', 'Miligramo', 'mg', 'MASS', 0.001, 3),
  ('GRAM', 'Gramo', 'g', 'MASS', 1, 3),
  ('KILOGRAM', 'Kilogramo', 'kg', 'MASS', 1000, 3),
  ('POUND', 'Libra', 'lb', 'MASS', 453.59237, 3),
  ('MILLILITER', 'Mililitro', 'ml', 'VOLUME', 1, 3),
  ('LITER', 'Litro', 'l', 'VOLUME', 1000, 3),
  ('SQUARE_METER', 'Metro cuadrado', 'm²', 'AREA', 1, 2),
  ('HECTARE', 'Hectárea', 'ha', 'AREA', 10000, 4),
  ('CENTIMETER', 'Centímetro', 'cm', 'LENGTH', 0.01, 2),
  ('METER', 'Metro', 'm', 'LENGTH', 1, 2),
  ('UNIT', 'Unidad', 'u', 'COUNT', 1, 0),
  ('DOSE', 'Dosis', 'dosis', 'COUNT', 1, 2);

INSERT INTO unit_usage_context(code, name, description) VALUES
  ('MEDICINE_DOSE', 'Dosis aplicada', 'Cantidad real administrada al animal.'),
  ('MEDICINE_RATE_NUMERATOR', 'Dosis sugerida', 'Numerador de una recomendación; el denominador se registra por separado.'),
  ('AGROCHEMICAL_AMOUNT', 'Cantidad de agroquímico', 'Cantidad usada en una limpieza o aplicación.'),
  ('ANIMAL_WEIGHT', 'Peso del animal', 'Unidades admitidas para pesajes.'),
  ('MILK_VOLUME', 'Producción de leche', 'Volumen producido por turno o día.'),
  ('LAND_AREA', 'Área de terreno', 'Superficie de potreros y propiedades.'),
  ('PRODUCT_QUANTITY', 'Cantidad de producto', 'Cantidad física; la presentación comercial se registra aparte.'),
  ('FEED_AMOUNT', 'Cantidad de alimento', 'Masa de alimento suministrado.'),
  ('LENGTH', 'Longitud', 'Medidas lineales.');

INSERT INTO allowed_context_unit(context_code, unit_code, is_default, sort_order) VALUES
  ('MEDICINE_DOSE', 'MILLIGRAM', false, 10),
  ('MEDICINE_DOSE', 'GRAM', false, 20),
  ('MEDICINE_DOSE', 'MILLILITER', true, 30),
  ('MEDICINE_DOSE', 'LITER', false, 40),
  ('MEDICINE_DOSE', 'UNIT', false, 50),
  ('MEDICINE_DOSE', 'DOSE', false, 60),
  ('MEDICINE_RATE_NUMERATOR', 'MILLIGRAM', true, 10),
  ('MEDICINE_RATE_NUMERATOR', 'GRAM', false, 20),
  ('MEDICINE_RATE_NUMERATOR', 'MILLILITER', false, 30),
  ('MEDICINE_RATE_NUMERATOR', 'UNIT', false, 40),
  ('AGROCHEMICAL_AMOUNT', 'GRAM', false, 10),
  ('AGROCHEMICAL_AMOUNT', 'KILOGRAM', false, 20),
  ('AGROCHEMICAL_AMOUNT', 'MILLILITER', false, 30),
  ('AGROCHEMICAL_AMOUNT', 'LITER', true, 40),
  ('ANIMAL_WEIGHT', 'GRAM', false, 10),
  ('ANIMAL_WEIGHT', 'KILOGRAM', true, 20),
  ('ANIMAL_WEIGHT', 'POUND', false, 30),
  ('MILK_VOLUME', 'MILLILITER', false, 10),
  ('MILK_VOLUME', 'LITER', true, 20),
  ('LAND_AREA', 'SQUARE_METER', false, 10),
  ('LAND_AREA', 'HECTARE', true, 20),
  ('PRODUCT_QUANTITY', 'GRAM', false, 10),
  ('PRODUCT_QUANTITY', 'KILOGRAM', false, 20),
  ('PRODUCT_QUANTITY', 'MILLILITER', false, 30),
  ('PRODUCT_QUANTITY', 'LITER', false, 40),
  ('PRODUCT_QUANTITY', 'UNIT', true, 50),
  ('FEED_AMOUNT', 'GRAM', false, 10),
  ('FEED_AMOUNT', 'KILOGRAM', true, 20),
  ('LENGTH', 'CENTIMETER', false, 10),
  ('LENGTH', 'METER', true, 20);

INSERT INTO account_species(account_id, species_code, enabled, configured_by)
SELECT id, 'BOVINE', true, owner_user_id
FROM administrative_account
ON CONFLICT DO NOTHING;

INSERT INTO property_species(property_id, species_code, enabled, configured_by)
SELECT id, 'BOVINE', true, created_by
FROM property
ON CONFLICT DO NOTHING;

CREATE FUNCTION seed_default_account_species() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_species(account_id, species_code, enabled, configured_by)
  SELECT NEW.id, code, true, NEW.owner_user_id
  FROM species_catalog
  WHERE code = 'BOVINE' AND active;
  RETURN NEW;
END;
$$;

CREATE TRIGGER administrative_account_seed_species
AFTER INSERT ON administrative_account
FOR EACH ROW EXECUTE FUNCTION seed_default_account_species();

CREATE FUNCTION seed_default_property_species() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO property_species(property_id, species_code, enabled, configured_by)
  SELECT NEW.id, species_code, true, NEW.created_by
  FROM account_species
  WHERE account_id = NEW.account_id AND enabled;
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_seed_species
AFTER INSERT ON property
FOR EACH ROW EXECUTE FUNCTION seed_default_property_species();

CREATE VIEW effective_property_species AS
SELECT
  p.id AS property_id,
  s.code AS species_code,
  s.ruleset_code,
  s.ruleset_version,
  s.active
    AND coalesce(a.enabled, false)
    AND coalesce(ps.enabled, false) AS enabled
FROM property p
CROSS JOIN species_catalog s
LEFT JOIN account_species a
  ON a.account_id = p.account_id
 AND a.species_code = s.code
LEFT JOIN property_species ps
  ON ps.property_id = p.id
 AND ps.species_code = s.code;

COMMIT;
