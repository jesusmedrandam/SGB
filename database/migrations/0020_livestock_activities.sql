BEGIN;

INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('ACTIVITY_VIEW','TASKS','Consultar actividades','Consultar labores sobre animales de la propiedad.'),
 ('ACTIVITY_MANAGE','TASKS','Gestionar actividades','Registrar, aplicar y cancelar actividades animales.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='ACTIVITY_VIEW' OR (pc.code='ACTIVITY_MANAGE'
 AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('ACTIVITY_VIEW','ACTIVITY_MANAGE')
ON CONFLICT DO NOTHING;

CREATE TABLE livestock_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 property_id uuid NOT NULL,
 kind varchar(16) NOT NULL CHECK(kind IN ('HERRAJE','DESCORNE','OTRA')),
 title varchar(180) NOT NULL,
 occurred_on date NOT NULL,
 description text,
 brand_id uuid,
 status varchar(16) NOT NULL DEFAULT 'BORRADOR'
   CHECK(status IN ('BORRADOR','COMPLETADA','CANCELADA')),
 applied_at timestamptz,
 cancelled_at timestamptz,
 created_by uuid NOT NULL REFERENCES app_user(id),
 updated_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1,
 FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
 FOREIGN KEY(brand_id,account_id) REFERENCES livestock_brand(id,account_id),
 CHECK((kind='HERRAJE')=(brand_id IS NOT NULL)),
 CHECK((status='BORRADOR' AND applied_at IS NULL AND cancelled_at IS NULL)
   OR (status='COMPLETADA' AND applied_at IS NOT NULL AND cancelled_at IS NULL)
   OR (status='CANCELADA' AND applied_at IS NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX livestock_activity_property_date ON livestock_activity(property_id,occurred_on DESC,created_at DESC);
CREATE TABLE livestock_activity_animal (
 activity_id uuid NOT NULL REFERENCES livestock_activity(id),
 animal_id uuid NOT NULL REFERENCES animal(id),
 PRIMARY KEY(activity_id,animal_id)
);
CREATE INDEX livestock_activity_animal_history ON livestock_activity_animal(animal_id,activity_id);
CREATE FUNCTION protect_livestock_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las actividades conservan su historial.' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'BORRADOR' OR NEW.account_id<>OLD.account_id OR NEW.property_id<>OLD.property_id
   OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'La actividad finalizada o su origen son inmutables.' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now(); RETURN NEW;
END; $$;
CREATE TRIGGER livestock_activity_protect BEFORE UPDATE OR DELETE ON livestock_activity
FOR EACH ROW EXECUTE FUNCTION protect_livestock_activity();
CREATE FUNCTION protect_livestock_activity_animal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status varchar(16); target_account uuid; target_property uuid;
BEGIN
 IF TG_OP='DELETE' THEN
   SELECT status INTO current_status FROM livestock_activity WHERE id=OLD.activity_id;
 ELSE
   SELECT status,account_id,property_id INTO current_status,target_account,target_property
     FROM livestock_activity WHERE id=NEW.activity_id;
   IF NOT EXISTS(SELECT 1 FROM animal a WHERE a.id=NEW.animal_id
      AND a.account_id=target_account AND a.property_id=target_property
      AND a.record_status='CURRENT') THEN
      RAISE EXCEPTION 'El animal no pertenece al origen de la actividad.' USING ERRCODE='23514';
   END IF;
 END IF;
 IF current_status<>'BORRADOR' THEN
   RAISE EXCEPTION 'Los animales de una actividad terminada son inmutables.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER livestock_activity_animal_protect BEFORE INSERT OR UPDATE OR DELETE ON livestock_activity_animal
FOR EACH ROW EXECUTE FUNCTION protect_livestock_activity_animal();
INSERT INTO media_entity_type_catalog(code,name) VALUES ('LIVESTOCK_ACTIVITY','Actividad animal');
COMMIT;
