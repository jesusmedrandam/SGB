BEGIN;

INSERT INTO module_catalog(code, name, scope, is_core) VALUES
  ('PASTURES', 'Potreros', 'ACCOUNT_PROPERTY', false),
  ('CORRALS', 'Corrales', 'ACCOUNT_PROPERTY', false);

-- Igual que los módulos existentes, los nuevos se habilitan al crear una cuenta.
-- Inicializamos también las cuentas y propiedades ya registradas.
INSERT INTO account_module(account_id, module_code, enabled, configured_by)
SELECT aa.id, m.code, true, aa.owner_user_id
FROM administrative_account aa CROSS JOIN module_catalog m
WHERE m.code IN ('PASTURES', 'CORRALS');

INSERT INTO property_module(property_id, module_code, enabled, configured_by)
SELECT p.id, m.code, true, p.owner_user_id
FROM property p CROSS JOIN module_catalog m
WHERE m.code IN ('PASTURES', 'CORRALS');

CREATE FUNCTION check_group_location_modules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM effective_property_module epm
      WHERE epm.property_id = NEW.property_id
        AND epm.module_code IN ('PASTURES', 'CORRALS', 'MOVEMENTS') AND epm.enabled) <> 3 THEN
    RAISE EXCEPTION 'Habilita Potreros, Corrales y Movimientos antes de ubicar un grupo.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER group_location_modules_required BEFORE INSERT ON group_location_assignment
FOR EACH ROW EXECUTE FUNCTION check_group_location_modules();

COMMIT;
