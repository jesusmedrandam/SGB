BEGIN;
-- Tasks can be private, assigned to selected people, or shared with the property.
ALTER TABLE agenda_item DROP CONSTRAINT agenda_item_check5;
COMMIT;
