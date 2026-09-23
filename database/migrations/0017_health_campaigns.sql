BEGIN;

INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('HEALTH_VIEW','HEALTH','Consultar sanidad','Consultar medicamentos y tratamientos.'),
 ('HEALTH_MANAGE','HEALTH','Gestionar sanidad','Registrar medicamentos y jornadas sanitarias.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='HEALTH_VIEW' OR (pc.code='HEALTH_MANAGE'
  AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('HEALTH_VIEW','HEALTH_MANAGE')
ON CONFLICT DO NOTHING;

CREATE TABLE health_medicine (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES administrative_account(id),
 name varchar(160) NOT NULL,
 kind varchar(24) NOT NULL CHECK(kind IN ('VACUNA','DESPARASITACION','ENFERMEDAD','OTRO')),
 active_ingredient text,
 default_unit_code varchar(30) NOT NULL REFERENCES measurement_unit(code),
 suggested_dose text,
 indications text,
 withdrawal_milk_days integer NOT NULL DEFAULT 0 CHECK(withdrawal_milk_days>=0),
 withdrawal_meat_days integer NOT NULL DEFAULT 0 CHECK(withdrawal_meat_days>=0),
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,account_id)
);
CREATE UNIQUE INDEX health_medicine_account_name ON health_medicine(account_id,lower(name));
CREATE FUNCTION validate_health_medicine_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM allowed_context_unit WHERE context_code='MEDICINE_DOSE'
   AND unit_code=NEW.default_unit_code) THEN
   RAISE EXCEPTION 'La unidad no es válida para dosis de medicamento.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER health_medicine_unit BEFORE INSERT OR UPDATE OF default_unit_code ON health_medicine
FOR EACH ROW EXECUTE FUNCTION validate_health_medicine_unit();

CREATE TABLE health_campaign (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 property_id uuid NOT NULL,
 medicine_id uuid NOT NULL,
 administration_route varchar(30) NOT NULL CHECK(administration_route IN
   ('ORAL','INTRAMUSCULAR','SUBCUTANEA','INTRAVENOSA','TOPICA','OTRA')),
 selection_mode varchar(16) NOT NULL CHECK(selection_mode IN ('TODOS','GRUPO','MANUAL')),
 group_id uuid,
 applied_on date NOT NULL,
 responsible varchar(200),
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
 FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
 FOREIGN KEY(medicine_id,account_id) REFERENCES health_medicine(id,account_id),
 FOREIGN KEY(group_id,property_id) REFERENCES livestock_group(id,property_id),
 CHECK((selection_mode='GRUPO')=(group_id IS NOT NULL)),
 CHECK((status='BORRADOR' AND applied_at IS NULL AND cancelled_at IS NULL)
   OR (status='COMPLETADO' AND applied_at IS NOT NULL AND cancelled_at IS NULL)
   OR (status='CANCELADO' AND cancelled_at IS NOT NULL AND applied_at IS NULL))
);
CREATE INDEX health_campaign_property_date ON health_campaign(property_id,applied_on DESC,created_at DESC);
CREATE TABLE health_campaign_animal (
 campaign_id uuid NOT NULL REFERENCES health_campaign(id),
 animal_id uuid NOT NULL REFERENCES animal(id),
 selected boolean NOT NULL DEFAULT true,
 dose numeric(12,3) NOT NULL CHECK(dose>0),
 unit_code varchar(30) NOT NULL REFERENCES measurement_unit(code),
 notes varchar(300),
 PRIMARY KEY(campaign_id,animal_id)
);
CREATE INDEX health_campaign_animal_history ON health_campaign_animal(animal_id,campaign_id);
CREATE FUNCTION protect_health_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las jornadas conservan su historial.' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'BORRADOR' OR NEW.account_id<>OLD.account_id OR NEW.property_id<>OLD.property_id
   OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'La jornada finalizada o su origen es inmutable.' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1;
 NEW.updated_at:=now();
 RETURN NEW;
END; $$;
CREATE TRIGGER health_campaign_protect BEFORE UPDATE OR DELETE ON health_campaign
FOR EACH ROW EXECUTE FUNCTION protect_health_campaign();
CREATE FUNCTION protect_health_campaign_animal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign_status varchar(16);
BEGIN
 SELECT status INTO campaign_status FROM health_campaign
 WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;
 IF campaign_status<>'BORRADOR' THEN
   RAISE EXCEPTION 'El detalle sanitario aplicado es inmutable.' USING ERRCODE='23514';
 END IF;
 IF TG_OP<>'DELETE' AND NOT EXISTS(SELECT 1 FROM health_campaign c JOIN animal a
   ON a.id=NEW.animal_id AND a.account_id=c.account_id AND a.property_id=c.property_id
   AND a.record_status='CURRENT' WHERE c.id=NEW.campaign_id) THEN
   RAISE EXCEPTION 'El animal no pertenece a la propiedad de la jornada.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER health_campaign_animal_protect BEFORE INSERT OR UPDATE OR DELETE ON health_campaign_animal
FOR EACH ROW EXECUTE FUNCTION protect_health_campaign_animal();
INSERT INTO media_entity_type_catalog(code,name) VALUES ('HEALTH_CAMPAIGN','Jornada sanitaria');
COMMIT;
