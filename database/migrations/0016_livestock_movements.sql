BEGIN;

INSERT INTO permission_catalog(code,module_code,name,description) VALUES
  ('MOVEMENT_VIEW','MOVEMENTS','Consultar movimientos','Consultar borradores y movimientos de la propiedad.'),
  ('MOVEMENT_MANAGE','MOVEMENTS','Gestionar movimientos','Crear y aplicar movimientos de animales.'),
  ('MOVEMENT_CANCEL','MOVEMENTS','Cancelar movimientos','Cancelar borradores de movimientos.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='MOVEMENT_VIEW' OR
  (pc.code IN ('MOVEMENT_MANAGE','MOVEMENT_CANCEL') AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('MOVEMENT_VIEW','MOVEMENT_MANAGE','MOVEMENT_CANCEL')
ON CONFLICT DO NOTHING;

CREATE TABLE livestock_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  source_property_id uuid NOT NULL,
  destination_property_id uuid NOT NULL,
  kind varchar(16) NOT NULL CHECK(kind IN ('UBICACION','GRUPO','PROPIEDAD','COMBINADO')),
  selection_mode varchar(16) NOT NULL CHECK(selection_mode IN ('GRUPO','MANUAL')),
  source_group_id uuid NOT NULL,
  destination_group_id uuid NOT NULL,
  source_location_id uuid,
  destination_location_id uuid,
  movement_on date NOT NULL,
  reason varchar(300) NOT NULL,
  notes text,
  status varchar(16) NOT NULL DEFAULT 'BORRADOR'
    CHECK(status IN ('BORRADOR','COMPLETADO','CANCELADO')),
  applied_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  FOREIGN KEY(source_property_id,account_id) REFERENCES property(id,account_id),
  FOREIGN KEY(destination_property_id,account_id) REFERENCES property(id,account_id),
  FOREIGN KEY(source_group_id,source_property_id) REFERENCES livestock_group(id,property_id),
  FOREIGN KEY(destination_group_id,destination_property_id) REFERENCES livestock_group(id,property_id),
  FOREIGN KEY(source_location_id,source_property_id) REFERENCES physical_location(id,property_id),
  FOREIGN KEY(destination_location_id,destination_property_id) REFERENCES physical_location(id,property_id),
  CHECK((kind='PROPIEDAD' AND source_property_id<>destination_property_id)
    OR (kind IN ('UBICACION','GRUPO') AND source_property_id=destination_property_id)
    OR kind='COMBINADO'),
  CHECK(kind<>'UBICACION' OR (selection_mode='GRUPO' AND source_group_id=destination_group_id
    AND source_location_id IS NOT NULL AND destination_location_id IS NOT NULL
    AND source_location_id<>destination_location_id)),
  CHECK((status='BORRADOR' AND applied_at IS NULL AND cancelled_at IS NULL)
    OR (status='COMPLETADO' AND applied_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status='CANCELADO' AND applied_at IS NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX livestock_movement_source_date ON livestock_movement(source_property_id,movement_on DESC,created_at DESC);
CREATE INDEX livestock_movement_destination_date ON livestock_movement(destination_property_id,movement_on DESC);

CREATE TABLE livestock_movement_animal (
  movement_id uuid NOT NULL REFERENCES livestock_movement(id),
  animal_id uuid NOT NULL REFERENCES animal(id),
  source_group_id uuid,
  source_location_id uuid,
  destination_group_id uuid,
  destination_location_id uuid,
  PRIMARY KEY(movement_id,animal_id)
);
CREATE INDEX livestock_movement_animal_history ON livestock_movement_animal(animal_id,movement_id);

CREATE FUNCTION protect_livestock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Los movimientos conservan su historial.' USING ERRCODE='23514'; END IF;
  IF OLD.status<>'BORRADOR' THEN
    RAISE EXCEPTION 'Un movimiento aplicado o cancelado es inmutable.' USING ERRCODE='23514';
  END IF;
  IF NEW.account_id<>OLD.account_id OR NEW.source_property_id<>OLD.source_property_id
    OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
    OR (NEW.status='COMPLETADO' AND NEW.applied_at IS NULL)
    OR (NEW.status='CANCELADO' AND NEW.cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'No se puede cambiar el origen o la identidad del movimiento.' USING ERRCODE='23514';
  END IF;
  NEW.version:=OLD.version+1;
  NEW.updated_at:=now();
  RETURN NEW;
END; $$;
CREATE TRIGGER livestock_movement_protect BEFORE UPDATE OR DELETE ON livestock_movement
FOR EACH ROW EXECUTE FUNCTION protect_livestock_movement();
CREATE FUNCTION protect_livestock_movement_animal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_status varchar(16);
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT status INTO movement_status FROM livestock_movement WHERE id=OLD.movement_id;
  ELSE
    SELECT status INTO movement_status FROM livestock_movement WHERE id=NEW.movement_id;
    IF NOT EXISTS(SELECT 1 FROM livestock_movement m JOIN animal a ON a.id=NEW.animal_id
      WHERE m.id=NEW.movement_id AND a.account_id=m.account_id
        AND a.property_id=m.source_property_id AND a.record_status='CURRENT') THEN
      RAISE EXCEPTION 'El animal no pertenece al origen del borrador.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF movement_status<>'BORRADOR' THEN
    RAISE EXCEPTION 'El detalle de un movimiento finalizado es inmutable.' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER livestock_movement_animal_protect BEFORE INSERT OR UPDATE OR DELETE ON livestock_movement_animal
FOR EACH ROW EXECUTE FUNCTION protect_livestock_movement_animal();

INSERT INTO media_entity_type_catalog(code,name) VALUES ('LIVESTOCK_MOVEMENT','Movimiento animal');

-- The origin catalog is historical provenance: on a same-account transfer its
-- original property-scoped entry remains attached to the animal.
CREATE OR REPLACE FUNCTION validate_animal_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM effective_property_species eps
    WHERE eps.property_id=NEW.property_id AND eps.species_code=NEW.species_code AND eps.enabled) THEN
    RAISE EXCEPTION 'La especie no está habilitada para esta propiedad.' USING ERRCODE='23514';
  END IF;
  IF NEW.origin_catalog_item_id IS NOT NULL AND NOT (
    TG_OP='UPDATE' AND NEW.account_id=OLD.account_id
    AND NEW.origin_catalog_item_id=OLD.origin_catalog_item_id
    AND NEW.property_id<>OLD.property_id
  ) AND NOT EXISTS(SELECT 1 FROM governed_catalog_item ci
    WHERE ci.id=NEW.origin_catalog_item_id AND ci.catalog_code='ANIMAL_ORIGINS'
      AND ci.active AND ci.deleted_at IS NULL
      AND (ci.system_defined OR ci.property_id=NEW.property_id)
      AND (ci.species_code IS NULL OR ci.species_code=NEW.species_code)) THEN
    RAISE EXCEPTION 'El origen seleccionado no es válido para este animal.' USING ERRCODE='23514';
  END IF;
  IF NEW.initial_weight_unit_code IS NOT NULL AND NOT EXISTS(SELECT 1 FROM allowed_context_unit acu
    WHERE acu.context_code='ANIMAL_WEIGHT' AND acu.unit_code=NEW.initial_weight_unit_code) THEN
    RAISE EXCEPTION 'La unidad indicada no puede utilizarse para el peso de un animal.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

COMMIT;
