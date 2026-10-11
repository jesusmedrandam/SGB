BEGIN;

INSERT INTO module_catalog(code,name,scope,is_core) VALUES
 ('REPRODUCTION_HEATS','Celos','ACCOUNT_PROPERTY',false),
 ('REPRODUCTION_INSEMINATION','Inseminación artificial','ACCOUNT_PROPERTY',false),
 ('REPRODUCTION_EMBRYO_TRANSFER','Transferencia de embriones','ACCOUNT_PROPERTY',false),
 ('REPRODUCTION_PREGNANCIES','Preñeces','ACCOUNT_PROPERTY',false),
 ('REPRODUCTION_BIRTHS','Partos','ACCOUNT_PROPERTY',false),
 ('REPRODUCTION_LOSSES','Pérdidas gestacionales','ACCOUNT_PROPERTY',false);

-- Mantiene las operaciones existentes y permite configurar cada sección.
INSERT INTO account_module(account_id,module_code,enabled,configured_by)
 SELECT a.id,m.code,true,a.owner_user_id FROM administrative_account a CROSS JOIN module_catalog m
 WHERE m.code LIKE 'REPRODUCTION\_%' ESCAPE '\';
INSERT INTO property_module(property_id,module_code,enabled,configured_by)
 SELECT p.id,m.code,true,p.owner_user_id FROM property p CROSS JOIN module_catalog m
 WHERE m.code LIKE 'REPRODUCTION\_%' ESCAPE '\';

-- Relaciona también las fotos de partos que ya estaban guardadas.
WITH relatives AS (
 SELECT ma.id AS source_id,ma.account_id,ma.storage_object_id,ma.property_id,b.mother_id AS animal_id,
   ma.created_by,ma.description,ma.captured_on FROM media_attachment ma
 JOIN reproduction_birth b ON b.id=ma.entity_id AND ma.entity_type='REPRODUCTION_BIRTH'
 WHERE ma.deleted_at IS NULL
 UNION
 SELECT ma.id,ma.account_id,ma.storage_object_id,ma.property_id,bc.animal_id,
   ma.created_by,ma.description,ma.captured_on FROM media_attachment ma
 JOIN reproduction_birth b ON b.id=ma.entity_id AND ma.entity_type='REPRODUCTION_BIRTH'
 JOIN reproduction_birth_calf bc ON bc.birth_id=b.id WHERE ma.deleted_at IS NULL
)
INSERT INTO media_attachment(account_id,storage_object_id,property_id,entity_type,entity_id,
 relation_code,created_by,description,captured_on)
 SELECT account_id,storage_object_id,property_id,'ANIMAL',animal_id,'GENERAL',created_by,description,captured_on
 FROM relatives ON CONFLICT (storage_object_id,entity_type,entity_id,relation_code) WHERE deleted_at IS NULL DO NOTHING;

COMMIT;
