BEGIN;

ALTER TABLE animal_location_assignment ADD COLUMN counts_for_occupancy boolean NOT NULL DEFAULT true;
ALTER TABLE group_location_assignment ADD COLUMN additional_location_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE livestock_movement ALTER COLUMN source_group_id DROP NOT NULL;
ALTER TABLE livestock_movement ALTER COLUMN destination_group_id DROP NOT NULL;
ALTER TABLE livestock_movement ADD COLUMN additional_destination_location_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE livestock_movement ADD COLUMN counts_for_occupancy boolean NOT NULL DEFAULT true;
ALTER TABLE livestock_movement ADD COLUMN pasture_conditions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE livestock_movement ADD COLUMN source_location_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE livestock_movement_animal ADD COLUMN source_counts_for_occupancy boolean NOT NULL DEFAULT true;
DO $$ DECLARE row record; BEGIN
 FOR row IN SELECT conname FROM pg_constraint WHERE conrelid='livestock_movement'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
  EXECUTE format('ALTER TABLE livestock_movement DROP CONSTRAINT %I',row.conname);
 END LOOP;
END $$;
ALTER TABLE livestock_movement ADD CONSTRAINT movement_kind_grazing CHECK(kind IN ('UBICACION','GRUPO','PROPIEDAD','COMBINADO','SEPARACION'));
ALTER TABLE livestock_movement ADD CONSTRAINT movement_properties_grazing CHECK(
 kind='PROPIEDAD' AND source_property_id<>destination_property_id OR
 kind IN ('UBICACION','GRUPO','SEPARACION') AND source_property_id=destination_property_id OR kind='COMBINADO');
ALTER TABLE livestock_movement ADD CONSTRAINT movement_groups_grazing CHECK(
 kind='SEPARACION' AND source_group_id IS NOT NULL AND destination_group_id IS NULL OR
 kind<>'SEPARACION' AND destination_group_id IS NOT NULL AND
 (source_group_id IS NOT NULL OR kind='GRUPO' AND selection_mode='MANUAL'));
-- Preserve first placements without a source, already allowed by migration 0024.
ALTER TABLE livestock_movement ADD CONSTRAINT movement_rotation_grazing CHECK(kind<>'UBICACION' OR
 selection_mode='GRUPO' AND source_group_id=destination_group_id AND destination_location_id IS NOT NULL
 AND (source_location_id IS NULL OR source_location_id<>destination_location_id));

CREATE OR REPLACE FUNCTION validate_group_location_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE places uuid[]; BEGIN
 IF TG_OP='UPDATE' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN RETURN NEW; END IF;
 places:=ARRAY[NEW.location_id]||NEW.additional_location_ids;
 IF cardinality(places)<>(SELECT count(DISTINCT id) FROM unnest(places) id) OR cardinality(places)>20 THEN
  RAISE EXCEPTION 'Selecciona hasta veinte ubicaciones distintas.' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM livestock_group WHERE id=NEW.group_id FOR UPDATE;
 PERFORM 1 FROM physical_location WHERE id=ANY(places) ORDER BY id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM livestock_group WHERE id=NEW.group_id AND property_id=NEW.property_id AND active)
  OR cardinality(places)<>(SELECT count(*) FROM physical_location WHERE id=ANY(places) AND property_id=NEW.property_id AND active
   AND (cardinality(places)=1 OR kind='PASTURE')) THEN
  RAISE EXCEPTION 'Las ubicaciones deben estar activas en la misma propiedad; solo se combinan potreros.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM group_location_assignment existing WHERE existing.id<>NEW.id
   AND (existing.group_id=NEW.group_id OR (ARRAY[existing.location_id]||existing.additional_location_ids) && places)
   AND tstzrange(existing.started_at,existing.ended_at,'[)') && tstzrange(NEW.started_at,NEW.ended_at,'[)')) THEN
  RAISE EXCEPTION 'El grupo o uno de los potreros ya tienen una ocupación en ese período.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER group_location_assignment_validate ON group_location_assignment;
CREATE TRIGGER group_location_assignment_validate BEFORE INSERT OR UPDATE OF property_id,group_id,location_id,additional_location_ids,started_at,ended_at
 ON group_location_assignment FOR EACH ROW EXECUTE FUNCTION validate_group_location_assignment();

CREATE VIEW group_location_use AS
 SELECT gla.id,gla.property_id,gla.group_id,place.location_id,gla.started_at,gla.ended_at,gla.movement_batch_id
 FROM group_location_assignment gla CROSS JOIN LATERAL unnest(ARRAY[gla.location_id]||gla.additional_location_ids) place(location_id);

CREATE VIEW animal_grazing_stay AS
 SELECT ala.id,ala.property_id,ala.animal_id,ala.location_id,ala.started_at,ala.ended_at,ala.movement_batch_id
 FROM animal_location_assignment ala WHERE ala.counts_for_occupancy
 UNION ALL
 SELECT ala.id,ala.property_id,ala.animal_id,extra.location_id,
  greatest(ala.started_at,aga.started_at,gla.started_at),
  nullif(least(coalesce(ala.ended_at,'infinity'),coalesce(aga.ended_at,'infinity'),coalesce(gla.ended_at,'infinity')),'infinity'),
  CASE WHEN gla.started_at>ala.started_at THEN gla.movement_batch_id ELSE ala.movement_batch_id END
 FROM animal_location_assignment ala JOIN animal_group_assignment aga ON aga.animal_id=ala.animal_id
 JOIN group_location_assignment gla ON gla.group_id=aga.group_id AND gla.location_id=ala.location_id
 CROSS JOIN LATERAL unnest(gla.additional_location_ids) extra(location_id)
 WHERE ala.counts_for_occupancy AND greatest(ala.started_at,aga.started_at,gla.started_at)<
  least(coalesce(ala.ended_at,'infinity'),coalesce(aga.ended_at,'infinity'),coalesce(gla.ended_at,'infinity'));

CREATE TABLE pasture_observation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),property_id uuid NOT NULL,location_id uuid NOT NULL,
 movement_batch_id uuid NOT NULL,observed_on date NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 entry_height_cm numeric(6,2) CHECK(entry_height_cm BETWEEN 0 AND 500),
 exit_state varchar(16) CHECK(exit_state IN ('REMAINS','DEPLETED')),
 created_by uuid NOT NULL REFERENCES app_user(id),
 FOREIGN KEY(location_id,property_id) REFERENCES physical_location(id,property_id),
 CHECK(entry_height_cm IS NOT NULL OR exit_state IS NOT NULL),UNIQUE(movement_batch_id,location_id)
);
CREATE TRIGGER pasture_observation_immutable BEFORE UPDATE OR DELETE ON pasture_observation
 FOR EACH ROW EXECUTE FUNCTION prevent_managed_record_delete();
CREATE INDEX pasture_observation_location_date ON pasture_observation(location_id,observed_on,recorded_at);

CREATE OR REPLACE VIEW physical_location_occupancy AS
 SELECT pl.id AS location_id,pl.account_id,pl.property_id,pl.kind,pl.name,
 count(DISTINCT a.id)::bigint AS occupant_count,min(ala.started_at) FILTER(WHERE a.id IS NOT NULL) AS occupied_since
 FROM physical_location pl LEFT JOIN animal_grazing_stay ala ON ala.location_id=pl.id AND ala.ended_at IS NULL
 LEFT JOIN animal a ON a.id=ala.animal_id AND a.record_status='CURRENT' AND a.availability_status_code IN ('ACTIVE','INACTIVE')
 GROUP BY pl.id,pl.account_id,pl.property_id,pl.kind,pl.name;

CREATE OR REPLACE VIEW animal_current_position AS
 SELECT a.id AS animal_id,a.account_id,a.property_id,aga.group_id,lg.name AS group_name,
 aga.started_at AS group_started_at,ala.location_id,pl.kind AS location_kind,
 coalesce((SELECT string_agg(loc.name,' + ' ORDER BY loc.name) FROM group_location_use use
  JOIN physical_location loc ON loc.id=use.location_id WHERE use.group_id=aga.group_id AND use.ended_at IS NULL),pl.name)::varchar(160) AS location_name,
 ala.started_at AS location_started_at,ala.counts_for_occupancy
 FROM animal a LEFT JOIN animal_group_assignment aga ON aga.animal_id=a.id AND aga.ended_at IS NULL
 LEFT JOIN livestock_group lg ON lg.id=aga.group_id
 LEFT JOIN animal_location_assignment ala ON ala.animal_id=a.id AND ala.ended_at IS NULL
 LEFT JOIN physical_location pl ON pl.id=ala.location_id WHERE a.record_status='CURRENT';
COMMIT;
