BEGIN;

INSERT INTO permission_catalog(code,module_code,name,description) VALUES
  ('WEIGHING_VIEW','WEIGHING','Consultar pesajes','Consultar el historial de peso de los animales.'),
  ('WEIGHING_MANAGE','WEIGHING','Gestionar pesajes','Registrar, corregir y anular pesajes.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='WEIGHING_VIEW' OR (pc.code='WEIGHING_MANAGE'
  AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('WEIGHING_VIEW','WEIGHING_MANAGE')
ON CONFLICT DO NOTHING;

CREATE TABLE animal_weighing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  property_id uuid NOT NULL,
  animal_id uuid NOT NULL,
  weighed_on date NOT NULL,
  weight numeric(12,3) NOT NULL CHECK (weight > 0),
  unit_code varchar(30) NOT NULL REFERENCES measurement_unit(code)
    CHECK (unit_code IN ('KILOGRAM','POUND')),
  method varchar(160),
  notes text CHECK (notes IS NULL OR length(notes) <= 3000),
  voided_at timestamptz,
  voided_by uuid REFERENCES app_user(id),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
  FOREIGN KEY(animal_id,account_id) REFERENCES animal(id,account_id),
  CHECK ((voided_at IS NULL)=(voided_by IS NULL))
);
CREATE INDEX animal_weighing_property_date ON animal_weighing(property_id,weighed_on DESC,created_at DESC);
CREATE INDEX animal_weighing_animal_date ON animal_weighing(animal_id,weighed_on DESC,created_at DESC);

CREATE FUNCTION protect_animal_weighing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Los pesajes se anulan; su historial no se elimina.' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM animal WHERE id=NEW.animal_id
      AND account_id=NEW.account_id AND property_id=NEW.property_id) THEN
      RAISE EXCEPTION 'El animal no pertenece a esta propiedad.' USING ERRCODE='23514';
    END IF;
  ELSE
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un pesaje anulado es inmutable.' USING ERRCODE='23514';
    END IF;
    IF NEW.account_id<>OLD.account_id OR NEW.property_id<>OLD.property_id
      OR NEW.animal_id<>OLD.animal_id OR NEW.created_by<>OLD.created_by
      OR NEW.created_at<>OLD.created_at OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
        AND NEW.voided_at IS NULL THEN
      RAISE EXCEPTION 'No se puede cambiar el origen o la identidad del pesaje.' USING ERRCODE='23514';
    END IF;
    NEW.version:=OLD.version+1;
    NEW.updated_at:=now();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM allowed_context_unit WHERE context_code='ANIMAL_WEIGHT'
    AND unit_code=NEW.unit_code) THEN
    RAISE EXCEPTION 'La unidad no admite peso animal.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER animal_weighing_protect BEFORE INSERT OR UPDATE OR DELETE ON animal_weighing
FOR EACH ROW EXECUTE FUNCTION protect_animal_weighing();

COMMIT;
