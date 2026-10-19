BEGIN;

INSERT INTO module_catalog(code,name,scope,is_core) VALUES('CASTRATION','Castración','ACCOUNT_PROPERTY',false);
INSERT INTO account_module(account_id,module_code,enabled,configured_by)
 SELECT id,'CASTRATION',true,owner_user_id FROM administrative_account;
INSERT INTO property_module(property_id,module_code,enabled,configured_by)
 SELECT id,'CASTRATION',true,owner_user_id FROM property;
INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('CASTRATION_VIEW','CASTRATION','Consultar castraciones','Consultar las castraciones registradas en Otras actividades.'),
 ('CASTRATION_MANAGE','CASTRATION','Registrar castraciones','Registrar, aplicar y cancelar borradores de castración.');
INSERT INTO role_template_permission(role_code,permission_code)
 SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
 WHERE pc.code='CASTRATION_VIEW' OR pc.code='CASTRATION_MANAGE' AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR');
INSERT INTO role_permission(role_id,permission_code)
 SELECT pr.id,rtp.permission_code FROM property_role pr JOIN role_template_permission rtp ON rtp.role_code=pr.code
 WHERE pr.is_system AND rtp.permission_code IN ('CASTRATION_VIEW','CASTRATION_MANAGE') ON CONFLICT DO NOTHING;

ALTER TABLE livestock_activity DROP CONSTRAINT livestock_activity_kind_check;
ALTER TABLE livestock_activity ADD CONSTRAINT livestock_activity_kind_check CHECK(kind IN ('HERRAJE','DESCORNE','CASTRACION','OTRA'));
ALTER TABLE animal ADD COLUMN castrated_on date;
ALTER TABLE animal ADD CONSTRAINT animal_castration_male_date CHECK(castrated_on IS NULL OR
 (sex='MALE' AND (birth_date IS NULL OR castrated_on>=birth_date)));
CREATE OR REPLACE VIEW latest_property_animal AS
 SELECT DISTINCT ON (property_id,identity_id) * FROM animal
 WHERE record_status='CURRENT' ORDER BY property_id,identity_id,created_at DESC,id DESC;

COMMIT;
