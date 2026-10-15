BEGIN;

DROP INDEX animal_tag_per_property_unique;
CREATE UNIQUE INDEX animal_tag_per_property_unique
  ON animal(property_id,lower(ear_tag_code::text))
  WHERE ear_tag_code IS NOT NULL AND record_status<>'PURGED' AND transferred_out_at IS NULL;

ALTER TABLE property_role ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
UPDATE role_template SET description='Control total de la propiedad, compartido entre sus propietarios.' WHERE code='OWNER';
UPDATE property_role SET description='Control total de la propiedad, compartido entre sus propietarios.' WHERE code='OWNER';

COMMIT;
