BEGIN;

INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('CLEANING_VIEW','PASTURE_CLEANING','Consultar limpiezas','Consultar labores y productos aplicados en potreros.'),
 ('CLEANING_MANAGE','PASTURE_CLEANING','Gestionar limpiezas','Registrar y completar labores de limpieza.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='CLEANING_VIEW' OR (pc.code='CLEANING_MANAGE'
 AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('CLEANING_VIEW','CLEANING_MANAGE')
ON CONFLICT DO NOTHING;

CREATE TABLE health_condition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 property_id uuid NOT NULL,
 animal_id uuid NOT NULL REFERENCES animal(id),
 kind varchar(160),
 detected_on date NOT NULL,
 description varchar(2000) NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'POR_RESOLVER'
   CHECK(status IN ('POR_RESOLVER','EN_TRATAMIENTO','RESUELTA')),
 resolved_on date,
 created_by uuid NOT NULL REFERENCES app_user(id),
 updated_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1,
 FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
 UNIQUE(id,animal_id),
 CHECK((status='RESUELTA')=(resolved_on IS NOT NULL)),
 CHECK(resolved_on IS NULL OR resolved_on>=detected_on)
);
CREATE INDEX health_condition_property_status ON health_condition(property_id,status,detected_on DESC);
CREATE INDEX health_condition_animal_history ON health_condition(animal_id,detected_on DESC);
CREATE FUNCTION validate_health_condition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM animal a WHERE a.id=NEW.animal_id
   AND a.account_id=NEW.account_id AND a.property_id=NEW.property_id
   AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE') THEN
   RAISE EXCEPTION 'El animal no está activo en la propiedad de la condición.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF NEW.account_id<>OLD.account_id OR NEW.property_id<>OLD.property_id
      OR NEW.animal_id<>OLD.animal_id OR NEW.created_by<>OLD.created_by
      OR NEW.created_at<>OLD.created_at OR OLD.status='RESUELTA' THEN
      RAISE EXCEPTION 'La condición resuelta o su animal son inmutables.' USING ERRCODE='23514';
   END IF;
   NEW.version:=OLD.version+1; NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER health_condition_validate BEFORE INSERT OR UPDATE ON health_condition
FOR EACH ROW EXECUTE FUNCTION validate_health_condition();
CREATE TRIGGER health_condition_no_delete BEFORE DELETE ON health_condition
FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();

ALTER TABLE health_campaign_animal ADD COLUMN condition_id uuid;
ALTER TABLE health_campaign_animal ADD CONSTRAINT health_campaign_animal_condition_fk
 FOREIGN KEY(condition_id,animal_id) REFERENCES health_condition(id,animal_id);

CREATE TABLE pasture_agrochemical (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES administrative_account(id),
 name varchar(160) NOT NULL,
 category varchar(120),
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,account_id)
);
CREATE UNIQUE INDEX pasture_agrochemical_name ON pasture_agrochemical(account_id,lower(name));
CREATE TABLE pasture_cleaning (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 property_id uuid NOT NULL,
 location_id uuid NOT NULL,
 started_on date NOT NULL,
 finished_on date,
 activities varchar(80)[] NOT NULL CHECK(cardinality(activities)>0 AND cardinality(activities)<=20),
 application_unit varchar(16) NOT NULL CHECK(application_unit IN ('TANQUES','BOMBADAS')),
 application_count numeric(12,2) CHECK(application_count>0),
 tank_capacity_liters numeric(12,2) CHECK(tank_capacity_liters>0),
 area_type varchar(8) NOT NULL CHECK(area_type IN ('TOTAL','PARCIAL')),
 partial_percent numeric(5,2) CHECK(partial_percent>0 AND partial_percent<100),
 area_value numeric(14,4),
 area_unit_code varchar(30) REFERENCES measurement_unit(code),
 status varchar(16) NOT NULL DEFAULT 'BORRADOR'
   CHECK(status IN ('BORRADOR','COMPLETADO','CANCELADO')),
 completed_at timestamptz,
 cancelled_at timestamptz,
 notes text,
 created_by uuid NOT NULL REFERENCES app_user(id),
 updated_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1,
 FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
 FOREIGN KEY(location_id,property_id) REFERENCES physical_location(id,property_id),
 CHECK((area_type='TOTAL' AND partial_percent IS NULL)
   OR (area_type='PARCIAL' AND partial_percent IS NOT NULL)),
 CHECK((area_value IS NULL)=(area_unit_code IS NULL)),
 CHECK(finished_on IS NULL OR finished_on>=started_on),
 CHECK((status='BORRADOR' AND completed_at IS NULL AND cancelled_at IS NULL)
   OR (status='COMPLETADO' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
   OR (status='CANCELADO' AND cancelled_at IS NOT NULL AND completed_at IS NULL))
);
CREATE INDEX pasture_cleaning_property_date ON pasture_cleaning(property_id,started_on DESC,created_at DESC);
CREATE TABLE pasture_cleaning_product (
 cleaning_id uuid NOT NULL REFERENCES pasture_cleaning(id),
 product_id uuid NOT NULL REFERENCES pasture_agrochemical(id),
 unit_code varchar(30) NOT NULL REFERENCES measurement_unit(code),
 quantity_per_application numeric(14,4) NOT NULL CHECK(quantity_per_application>0),
 total_quantity numeric(18,4) NOT NULL CHECK(total_quantity>0),
 notes varchar(300),
 PRIMARY KEY(cleaning_id,product_id)
);
CREATE FUNCTION calculate_cleaning_product_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE applications numeric(12,2);
BEGIN
 SELECT application_count INTO applications FROM pasture_cleaning WHERE id=NEW.cleaning_id;
 IF applications IS NULL THEN
   RAISE EXCEPTION 'Indica tanques o bombadas para calcular el consumo.' USING ERRCODE='23514';
 END IF;
 NEW.total_quantity:=round(NEW.quantity_per_application*applications,4);
 RETURN NEW;
END; $$;
CREATE TRIGGER pasture_cleaning_product_calculate BEFORE INSERT OR UPDATE ON pasture_cleaning_product
FOR EACH ROW EXECUTE FUNCTION calculate_cleaning_product_total();
CREATE FUNCTION refresh_cleaning_product_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE pasture_cleaning_product SET total_quantity=round(quantity_per_application*NEW.application_count,4)
 WHERE cleaning_id=NEW.id;
 RETURN NEW;
END; $$;
CREATE TRIGGER pasture_cleaning_totals_refresh AFTER UPDATE OF application_count ON pasture_cleaning
FOR EACH ROW WHEN (OLD.application_count IS DISTINCT FROM NEW.application_count)
EXECUTE FUNCTION refresh_cleaning_product_totals();
CREATE TABLE pasture_cleaning_operator (
 cleaning_id uuid NOT NULL REFERENCES pasture_cleaning(id),
 name varchar(160) NOT NULL,
 function varchar(100),
 notes varchar(300),
 PRIMARY KEY(cleaning_id,name)
);
CREATE FUNCTION protect_pasture_cleaning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las limpiezas conservan su historial.' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'BORRADOR' OR NEW.account_id<>OLD.account_id OR NEW.property_id<>OLD.property_id
   OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'La limpieza finalizada o su origen es inmutable.' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now(); RETURN NEW;
END; $$;
CREATE TRIGGER pasture_cleaning_protect BEFORE UPDATE OR DELETE ON pasture_cleaning
FOR EACH ROW EXECUTE FUNCTION protect_pasture_cleaning();
CREATE FUNCTION protect_pasture_cleaning_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleaning_id uuid; current_status varchar(16);
BEGIN
 IF TG_OP='DELETE' THEN cleaning_id:=OLD.cleaning_id; ELSE cleaning_id:=NEW.cleaning_id; END IF;
 SELECT status INTO current_status FROM pasture_cleaning WHERE id=cleaning_id;
 IF current_status<>'BORRADOR' THEN
   RAISE EXCEPTION 'Los productos y operadores de una limpieza finalizada son inmutables.' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='pasture_cleaning_product' AND TG_OP<>'DELETE' AND NOT EXISTS(
   SELECT 1 FROM pasture_cleaning c JOIN pasture_agrochemical p
     ON p.id=NEW.product_id AND p.account_id=c.account_id WHERE c.id=cleaning_id) THEN
   RAISE EXCEPTION 'El producto no pertenece a la cuenta de la limpieza.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pasture_cleaning_product_protect BEFORE INSERT OR UPDATE OR DELETE ON pasture_cleaning_product
FOR EACH ROW EXECUTE FUNCTION protect_pasture_cleaning_detail();
CREATE TRIGGER pasture_cleaning_operator_protect BEFORE INSERT OR UPDATE OR DELETE ON pasture_cleaning_operator
FOR EACH ROW EXECUTE FUNCTION protect_pasture_cleaning_detail();
COMMIT;
