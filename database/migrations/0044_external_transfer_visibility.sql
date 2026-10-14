BEGIN;

ALTER TABLE property ADD COLUMN external_transfer_visibility varchar(20) NOT NULL DEFAULT 'HIDDEN'
  CHECK (external_transfer_visibility IN ('HIDDEN','COLLABORATORS','PUBLIC'));
ALTER TABLE property ADD COLUMN external_transfer_visible_until timestamptz;
ALTER TABLE property ADD CONSTRAINT external_transfer_visibility_expiry
  CHECK (external_transfer_visible_until IS NULL OR external_transfer_visibility='PUBLIC');
ALTER TABLE external_animal_transfer ADD COLUMN uses_property_visibility boolean NOT NULL DEFAULT false;

COMMIT;
