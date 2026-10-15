BEGIN;

ALTER TABLE livestock_group ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'INTERNAL'
  CHECK (kind IN ('INTERNAL','EXTERNAL'));
ALTER TABLE livestock_group ADD COLUMN external_place varchar(160);
ALTER TABLE livestock_group ADD COLUMN external_contact varchar(160);
ALTER TABLE livestock_group ADD CONSTRAINT livestock_group_external_reference CHECK (
  kind='EXTERNAL' AND length(btrim(external_place))>0 AND external_place IS NOT NULL
  OR kind='INTERNAL' AND external_place IS NULL AND external_contact IS NULL);

CREATE FUNCTION protect_external_group_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='livestock_group' THEN
    IF NEW.kind<>OLD.kind THEN
      RAISE EXCEPTION 'El tipo del grupo no cambia; registra un movimiento hacia otro grupo.' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='group_location_assignment' THEN
    IF NEW.ended_at IS NULL AND EXISTS(SELECT 1 FROM livestock_group WHERE id=NEW.group_id AND kind='EXTERNAL') THEN
      RAISE EXCEPTION 'Los grupos externos no ocupan potreros ni corrales.' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='animal_group_assignment' THEN
    IF NEW.ended_at IS NULL AND EXISTS(SELECT 1 FROM livestock_group WHERE id=NEW.group_id AND kind='EXTERNAL')
      AND EXISTS(SELECT 1 FROM animal_location_assignment WHERE animal_id=NEW.animal_id AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'Cierra la ubicación anterior antes de asignar un grupo externo.' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.ended_at IS NULL AND EXISTS(SELECT 1 FROM animal_group_assignment a JOIN livestock_group g ON g.id=a.group_id
      WHERE a.animal_id=NEW.animal_id AND a.ended_at IS NULL AND g.kind='EXTERNAL') THEN
      RAISE EXCEPTION 'Un animal en un grupo externo no ocupa un potrero o corral.' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER livestock_group_type_immutable BEFORE UPDATE OF kind ON livestock_group
  FOR EACH ROW EXECUTE FUNCTION protect_external_group_placement();
CREATE TRIGGER external_group_no_location BEFORE INSERT OR UPDATE ON group_location_assignment
  FOR EACH ROW EXECUTE FUNCTION protect_external_group_placement();
CREATE TRIGGER external_animal_no_location BEFORE INSERT OR UPDATE ON animal_location_assignment
  FOR EACH ROW EXECUTE FUNCTION protect_external_group_placement();
CREATE TRIGGER external_group_animal_no_location BEFORE INSERT OR UPDATE ON animal_group_assignment
  FOR EACH ROW EXECUTE FUNCTION protect_external_group_placement();

COMMIT;
