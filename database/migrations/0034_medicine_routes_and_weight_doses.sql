BEGIN;

UPDATE catalog_definition SET scope='PROPERTY',mutability='PROPERTY_EXTENSIBLE'
WHERE code='ADMINISTRATION_ROUTES';
INSERT INTO governed_catalog_item(catalog_code,item_code,name,system_defined) VALUES
 ('ADMINISTRATION_ROUTES','ORAL','Oral',true),
 ('ADMINISTRATION_ROUTES','INTRAMUSCULAR','Intramuscular',true),
 ('ADMINISTRATION_ROUTES','SUBCUTANEA','Subcutánea',true),
 ('ADMINISTRATION_ROUTES','INTRAVENOSA','Intravenosa',true),
 ('ADMINISTRATION_ROUTES','TOPICA','Tópica',true),
 ('ADMINISTRATION_ROUTES','OTRA','Otra',true);

ALTER TABLE health_medicine
 ADD COLUMN administration_routes text[] NOT NULL DEFAULT ARRAY['ORAL','INTRAMUSCULAR','SUBCUTANEA','INTRAVENOSA','TOPICA','OTRA'],
 ADD COLUMN dose_amount numeric(18,6),
 ADD COLUMN dose_weight numeric(18,6),
 ADD COLUMN dose_weight_unit_code varchar(30) REFERENCES measurement_unit(code),
 ADD CONSTRAINT health_medicine_dose_reference CHECK (
   (dose_amount IS NULL AND dose_weight IS NULL AND dose_weight_unit_code IS NULL)
   OR (dose_amount IS NOT NULL AND dose_amount>0 AND dose_amount<=1000000 AND
     ((dose_weight IS NULL AND dose_weight_unit_code IS NULL)
       OR (dose_weight IS NOT NULL AND dose_weight_unit_code IS NOT NULL AND dose_weight>0
         AND dose_weight<=1000000 AND dose_weight_unit_code IN ('KILOGRAM','POUND')))));
ALTER TABLE health_campaign DROP CONSTRAINT health_campaign_administration_route_check;
ALTER TABLE health_campaign ALTER COLUMN administration_route TYPE varchar(80);
ALTER TABLE health_campaign ADD CONSTRAINT health_campaign_administration_route_check CHECK (
 administration_route IN ('ORAL','INTRAMUSCULAR','SUBCUTANEA','INTRAVENOSA','TOPICA','OTRA')
 OR administration_route ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

COMMIT;
