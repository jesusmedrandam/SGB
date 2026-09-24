BEGIN;
UPDATE catalog_definition SET mutability='PROPERTY_EXTENSIBLE'
WHERE code IN ('GRASS_TYPES','HEALTH_CONDITION_TYPES','AGROCHEMICAL_CATEGORIES','MEDIA_TAGS','MOVEMENT_REASONS','TREATMENT_TYPES');
INSERT INTO governed_catalog_item(catalog_code,item_code,name,system_defined) VALUES
('GRASS_TYPES','BRACHIARIA','Brachiaria',true),
('GRASS_TYPES','GUINEA','Guinea',true),
('GRASS_TYPES','ELEPHANT','Elefante',true),
('GRASS_TYPES','STAR','Estrella',true),
('GRASS_TYPES','KIKUYU','Kikuyo',true),
('HEALTH_CONDITION_TYPES','WOUND','Herida',true),
('HEALTH_CONDITION_TYPES','PARASITES','Parásitos',true),
('HEALTH_CONDITION_TYPES','MASTITIS','Mastitis',true),
('HEALTH_CONDITION_TYPES','LAMENESS','Cojera',true),
('HEALTH_CONDITION_TYPES','FEVER','Fiebre',true),
('AGROCHEMICAL_CATEGORIES','HERBICIDE','Herbicida',true),
('AGROCHEMICAL_CATEGORIES','ADJUVANT','Coadyuvante',true),
('AGROCHEMICAL_CATEGORIES','INSECTICIDE','Insecticida',true),
('AGROCHEMICAL_CATEGORIES','FUNGICIDE','Fungicida',true),
('AGROCHEMICAL_CATEGORIES','FERTILIZER','Fertilizante',true),
('MEDIA_TAGS','BIRTH','Parto',true),
('MEDIA_TAGS','VACCINATION','Vacunación',true),
('MEDIA_TAGS','DEHORNING','Descorne',true),
('MEDIA_TAGS','BRANDING','Herraje',true),
('MOVEMENT_REASONS','ROTATION','Rotación de potrero',true),
('MOVEMENT_REASONS','GROUP_CHANGE','Cambio de grupo',true),
('MOVEMENT_REASONS','PROPERTY_TRANSFER','Traslado a otra propiedad',true),
('TREATMENT_TYPES','ANTIBIOTIC','Antibiótico',true),
('TREATMENT_TYPES','ANALGESIC','Analgésico',true),
('TREATMENT_TYPES','VITAMIN','Vitaminización',true),
('TREATMENT_TYPES','ANTIPARASITIC','Antiparasitario',true)
ON CONFLICT DO NOTHING;
ALTER TABLE pasture_grass ADD COLUMN catalog_item_id uuid REFERENCES governed_catalog_item(id);
ALTER TABLE pasture_agrochemical ADD COLUMN active_ingredient text,
  ADD COLUMN formulated_by varchar(200), ADD COLUMN description text;
ALTER TABLE health_medicine ADD COLUMN treatment_catalog_item_id uuid REFERENCES governed_catalog_item(id);
ALTER TABLE pasture_cleaning ALTER COLUMN application_unit DROP NOT NULL;
ALTER TABLE media_attachment ADD COLUMN description varchar(2000),
  ADD COLUMN captured_on date;
CREATE TABLE media_attachment_tag (
  attachment_id uuid NOT NULL REFERENCES media_attachment(id),
  tag_id uuid NOT NULL REFERENCES governed_catalog_item(id),
  PRIMARY KEY(attachment_id,tag_id)
);
CREATE INDEX media_attachment_tag_lookup ON media_attachment_tag(tag_id);
COMMIT;
