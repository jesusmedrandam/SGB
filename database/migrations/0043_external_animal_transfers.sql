BEGIN;

ALTER TABLE administrative_account ADD COLUMN external_transfers_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN animal_receive_code uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX property_animal_receive_code_unique ON property(animal_receive_code);
ALTER TABLE animal ADD COLUMN identity_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE animal ADD COLUMN transferred_out_at timestamptz;
CREATE UNIQUE INDEX animal_one_live_identity ON animal(identity_id)
  WHERE record_status='CURRENT' AND availability_status_code IN ('ACTIVE','MISSING');

CREATE TABLE external_animal_transfer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_property_id uuid NOT NULL REFERENCES property(id),
  destination_property_id uuid NOT NULL REFERENCES property(id),
  source_name varchar(160) NOT NULL,
  destination_name varchar(160) NOT NULL,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  source_role_id uuid NOT NULL REFERENCES property_role(id),
  movement_on date NOT NULL,
  reason varchar(300) NOT NULL,
  notes varchar(5000),
  status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','REJECTED','CANCELLED')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES app_user(id),
  decision_reason varchar(500),
  CHECK(source_property_id<>destination_property_id),
  CHECK((status='PENDING')=(decided_at IS NULL AND decided_by IS NULL))
);
CREATE INDEX external_transfer_property_time ON external_animal_transfer(destination_property_id,created_at DESC);
CREATE INDEX external_transfer_source_time ON external_animal_transfer(source_property_id,created_at DESC);
CREATE TABLE external_animal_transfer_item (
  transfer_id uuid NOT NULL REFERENCES external_animal_transfer(id),
  source_animal_id uuid NOT NULL REFERENCES animal(id),
  destination_animal_id uuid REFERENCES animal(id),
  source_version bigint NOT NULL,
  snapshot_digest char(64) NOT NULL,
  pending boolean NOT NULL DEFAULT true,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(transfer_id,source_animal_id),
  UNIQUE(destination_animal_id)
);
CREATE UNIQUE INDEX external_transfer_one_pending_animal ON external_animal_transfer_item(source_animal_id) WHERE pending;
CREATE FUNCTION finish_external_transfer_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'PENDING' THEN UPDATE external_animal_transfer_item SET pending=false WHERE transfer_id=NEW.id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_transfer_finish AFTER UPDATE OF status ON external_animal_transfer
  FOR EACH ROW EXECUTE FUNCTION finish_external_transfer_items();
CREATE TABLE animal_received_history (
  animal_id uuid PRIMARY KEY REFERENCES animal(id),
  transfer_id uuid NOT NULL REFERENCES external_animal_transfer(id),
  source_animal_id uuid NOT NULL REFERENCES animal(id),
  snapshot jsonb NOT NULL,
  has_given_birth boolean NOT NULL,
  has_confirmed_offspring boolean NOT NULL,
  last_birth_on date,
  last_loss_on date,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_transfer_media_grant (
  storage_object_id uuid NOT NULL REFERENCES storage_object(id),
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  animal_id uuid NOT NULL REFERENCES animal(id),
  transfer_id uuid NOT NULL REFERENCES external_animal_transfer(id),
  PRIMARY KEY(storage_object_id,animal_id)
);
CREATE TABLE external_transfer_reference_map (
  source_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  kind varchar(30) NOT NULL,
  destination_id uuid NOT NULL,
  PRIMARY KEY(source_id,account_id,kind)
);

-- The original tenant boundary is retained; only an accepted animal transfer can grant a shared file.
ALTER TABLE media_attachment DROP CONSTRAINT media_attachment_storage_account_fk;
ALTER TABLE media_attachment ADD CONSTRAINT media_attachment_storage_fk FOREIGN KEY(storage_object_id) REFERENCES storage_object(id);
ALTER TABLE media_attachment ADD COLUMN imported_record_type varchar(60);
ALTER TABLE media_attachment ADD COLUMN imported_record_details jsonb;
CREATE FUNCTION validate_shared_media_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM storage_object s WHERE s.id=NEW.storage_object_id AND (
    s.account_id=NEW.account_id OR NEW.entity_type='ANIMAL' AND EXISTS(
      SELECT 1 FROM external_transfer_media_grant g JOIN external_animal_transfer t ON t.id=g.transfer_id
      JOIN external_animal_transfer_item i ON i.transfer_id=t.id AND i.destination_animal_id=g.animal_id
      WHERE g.storage_object_id=s.id AND g.account_id=NEW.account_id AND g.animal_id=NEW.entity_id
        AND t.destination_property_id=NEW.property_id AND t.status='ACCEPTED'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.snapshot->'media') m WHERE m->>'storage_object_id'=s.id::text)
    )
  )) THEN RAISE EXCEPTION 'El archivo no pertenece a esta cuenta ni fue recibido mediante un traslado aprobado.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_media_scope BEFORE INSERT OR UPDATE OF storage_object_id,account_id,property_id,entity_id,entity_type
  ON media_attachment FOR EACH ROW EXECUTE FUNCTION validate_shared_media_attachment();

CREATE OR REPLACE VIEW account_media_storage_usage AS
SELECT a.id AS account_id,coalesce(sum(s.byte_size),0)::bigint AS used_value
FROM administrative_account a LEFT JOIN storage_object s ON
  s.status IN ('AVAILABLE','QUARANTINED','TRASHED','DELETE_PENDING') AND (
    EXISTS(SELECT 1 FROM media_attachment m WHERE m.storage_object_id=s.id AND m.account_id=a.id AND m.deleted_at IS NULL)
    OR s.account_id=a.id AND NOT EXISTS(SELECT 1 FROM media_attachment m WHERE m.storage_object_id=s.id AND m.deleted_at IS NULL)
  ) GROUP BY a.id;

ALTER TABLE milk_lactation ALTER COLUMN birth_id DROP NOT NULL;
ALTER TABLE milk_lactation ADD COLUMN external_transfer_id uuid REFERENCES external_animal_transfer(id);
ALTER TABLE milk_lactation ADD CONSTRAINT lactation_birth_or_transfer CHECK(birth_id IS NOT NULL OR external_transfer_id IS NOT NULL);
CREATE OR REPLACE FUNCTION validate_milk_lactation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM reproduction_birth b JOIN animal a ON a.id=b.mother_id
    WHERE b.id=NEW.birth_id AND b.mother_id=NEW.cow_id AND b.account_id=NEW.account_id
      AND b.property_id=NEW.property_id AND b.occurred_on=NEW.started_on AND a.sex='FEMALE' AND a.record_status='CURRENT')
    AND NOT EXISTS(SELECT 1 FROM animal_received_history h JOIN external_animal_transfer t ON t.id=h.transfer_id
      JOIN animal a ON a.id=h.animal_id WHERE h.animal_id=NEW.cow_id AND t.id=NEW.external_transfer_id
      AND t.status='ACCEPTED' AND a.account_id=NEW.account_id AND a.property_id=NEW.property_id
      AND a.sex='FEMALE' AND h.last_birth_on=NEW.started_on) THEN
    RAISE EXCEPTION 'La lactancia debe pertenecer al parto de esta vaca o a su traslado aprobado.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM milk_lactation l WHERE l.cow_id=NEW.cow_id AND l.id<>NEW.id
    AND daterange(l.started_on,COALESCE(l.ended_on,'infinity'::date),'[]')
      &&daterange(NEW.started_on,COALESCE(NEW.ended_on,'infinity'::date),'[]')) THEN
    RAISE EXCEPTION 'Las lactancias de esta vaca se superponen.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE app_notification DROP CONSTRAINT app_notification_kind_check;
ALTER TABLE app_notification ADD CONSTRAINT app_notification_kind_check CHECK(kind IN
  ('AGENDA_ASSIGNED','AGENDA_COMPLETED','AGENDA_CANCELLED','EXTERNAL_TRANSFER_RECEIVED','EXTERNAL_TRANSFER_DECIDED'));
ALTER TABLE app_notification ADD COLUMN external_transfer_id uuid REFERENCES external_animal_transfer(id);


CREATE OR REPLACE FUNCTION classify_animal(p_animal_id uuid,p_date date) RETURNS varchar(20)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  subject animal%ROWTYPE;
  female_months integer;
  male_months integer;
  offspring boolean;
BEGIN
  SELECT * INTO subject FROM animal WHERE id=p_animal_id AND record_status='CURRENT';
  IF NOT FOUND THEN RETURN 'SIN_CLASIFICAR'; END IF;
  SELECT COALESCE(policy.female_adult_months,12),COALESCE(policy.male_adult_months,12)
    INTO female_months,male_months FROM property prop
    LEFT JOIN account_animal_classification_policy policy ON policy.account_id=prop.account_id
    WHERE prop.id=subject.property_id;
  SELECT EXISTS(
    SELECT 1 FROM animal_parentage ap JOIN animal child ON child.id=ap.child_animal_id
    WHERE ap.parent_animal_id=p_animal_id AND ap.removed_at IS NULL
      AND child.record_status<>'PURGED' AND (child.birth_date IS NULL OR child.birth_date<=p_date)
  ) OR EXISTS(
    SELECT 1 FROM reproduction_birth birth
    LEFT JOIN reproduction_pregnancy preg ON preg.id=birth.pregnancy_id
    WHERE birth.occurred_on<=p_date
      AND (subject.sex='FEMALE' AND birth.mother_id=p_animal_id
        OR subject.sex='MALE' AND preg.father_id=p_animal_id)
  ) INTO offspring;
  IF subject.sex='FEMALE' THEN
    IF offspring OR EXISTS(SELECT 1 FROM animal_received_history WHERE animal_id=p_animal_id AND has_confirmed_offspring) OR EXISTS(SELECT 1 FROM animal_received_history WHERE animal_id=p_animal_id AND has_given_birth) THEN RETURN 'VACA'; END IF;
    IF subject.birth_date IS NOT NULL
      AND (subject.birth_date+make_interval(months=>female_months))::date>p_date THEN
      RETURN 'TERNERA';
    END IF;
    RETURN 'VACONA';
  END IF;
  IF subject.sex='MALE' THEN
    IF offspring OR EXISTS(SELECT 1 FROM animal_received_history WHERE animal_id=p_animal_id AND has_confirmed_offspring) OR EXISTS(
      SELECT 1 FROM reproduction_pregnancy preg
      WHERE preg.father_id=p_animal_id AND preg.status IN ('CONFIRMED','BORN','LOST')
        AND preg.confirmed_on<=p_date
    ) THEN RETURN 'TORO'; END IF;
    IF subject.birth_date IS NOT NULL
      AND (subject.birth_date+make_interval(months=>male_months))::date>p_date THEN
      RETURN 'TERNERO';
    END IF;
    RETURN 'TORETE';
  END IF;
  RETURN 'SIN_CLASIFICAR';
END;
$$;
CREATE OR REPLACE FUNCTION protect_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las notificaciones no se eliminan.' USING ERRCODE='23514'; END IF;
 IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.id<>OLD.id
  OR NEW.user_id<>OLD.user_id OR NEW.property_id<>OLD.property_id
  OR NEW.agenda_item_id IS DISTINCT FROM OLD.agenda_item_id OR NEW.kind<>OLD.kind
  OR NEW.external_transfer_id IS DISTINCT FROM OLD.external_transfer_id OR NEW.title<>OLD.title OR NEW.message<>OLD.message OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Solo se permite marcar la notificación como leída.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION animal_latest_birth_on(p_animal uuid,p_on date DEFAULT 'infinity'::date) RETURNS date LANGUAGE sql STABLE AS $$
 SELECT max(on_date) FROM (SELECT occurred_on AS on_date FROM reproduction_birth WHERE mother_id=p_animal
 UNION ALL SELECT last_birth_on FROM animal_received_history WHERE animal_id=p_animal) dates WHERE on_date<=p_on;
$$;
CREATE FUNCTION animal_latest_loss_on(p_animal uuid,p_on date DEFAULT 'infinity'::date) RETURNS date LANGUAGE sql STABLE AS $$
 SELECT max(on_date) FROM (SELECT occurred_on AS on_date FROM reproduction_loss WHERE cow_id=p_animal
 UNION ALL SELECT last_loss_on FROM animal_received_history WHERE animal_id=p_animal) dates WHERE on_date<=p_on;
$$;
CREATE FUNCTION protect_transferred_animal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.transferred_out_at IS NOT NULL AND (NEW.transferred_out_at IS DISTINCT FROM OLD.transferred_out_at
  OR NEW.identity_id<>OLD.identity_id OR NEW.availability_status_code<>'INACTIVE'
  OR NEW.property_id<>OLD.property_id OR NEW.account_id<>OLD.account_id) THEN
  RAISE EXCEPTION 'El registro trasladado permanece inactivo en origen.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transferred_animal_protect BEFORE UPDATE ON animal FOR EACH ROW EXECUTE FUNCTION protect_transferred_animal();
CREATE OR REPLACE FUNCTION validate_milk_production() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM animal a JOIN milk_animal_state ms ON ms.cow_id=a.id
    LEFT JOIN account_reproduction_setting s ON s.account_id=a.account_id
    WHERE a.id=NEW.cow_id AND a.account_id=NEW.account_id AND a.property_id=NEW.property_id
      AND a.sex='FEMALE' AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE'
      AND ms.enabled AND ms.account_id=NEW.account_id AND ms.property_id=NEW.property_id
      AND NEW.produced_on BETWEEN animal_latest_birth_on(a.id,NEW.produced_on) AND animal_latest_birth_on(a.id,NEW.produced_on)+COALESCE(s.max_milking_days,305))
    OR (NEW.lactation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM milk_lactation l
      WHERE l.id=NEW.lactation_id AND l.cow_id=NEW.cow_id
        AND l.account_id=NEW.account_id AND l.property_id=NEW.property_id
        AND l.in_milking AND NEW.produced_on>=l.started_on
        AND (l.ended_on IS NULL OR NEW.produced_on<=l.ended_on)))
    OR (NEW.lactation_id IS NULL AND EXISTS (SELECT 1 FROM milk_lactation l
      WHERE l.cow_id=NEW.cow_id AND l.property_id=NEW.property_id AND l.ended_on IS NULL)) THEN
    RAISE EXCEPTION 'La vaca debe estar en ordeño tras un parto reciente.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION enforce_managed_animal_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed bigint;
  current_count bigint;
  new_counts boolean;
  old_counts boolean := false;
BEGIN
  SELECT aas.counts_toward_quota AND NEW.record_status = 'CURRENT' AND NEW.transferred_out_at IS NULL
    INTO new_counts
  FROM animal_availability_status aas
  WHERE aas.code = NEW.availability_status_code;

  IF TG_OP = 'UPDATE' THEN
    SELECT aas.counts_toward_quota AND OLD.record_status = 'CURRENT' AND OLD.transferred_out_at IS NULL
      INTO old_counts
    FROM animal_availability_status aas
    WHERE aas.code = OLD.availability_status_code;
  END IF;

  IF NOT new_counts OR (old_counts AND NEW.account_id = OLD.account_id) THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM administrative_account WHERE id = NEW.account_id FOR UPDATE;

  SELECT limit_value INTO allowed
  FROM effective_account_quota
  WHERE account_id = NEW.account_id AND quota_code = 'MANAGED_ANIMALS';

  IF allowed IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO current_count
  FROM animal a
  JOIN animal_availability_status aas
    ON aas.code = a.availability_status_code
   AND aas.counts_toward_quota
  WHERE a.account_id = NEW.account_id
    AND a.record_status = 'CURRENT' AND a.transferred_out_at IS NULL
    AND a.id <> NEW.id;

  IF current_count >= allowed THEN
    RAISE EXCEPTION 'Se alcanzó el límite de animales gestionados de la cuenta.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE VIEW account_managed_animal_usage AS
SELECT
  aa.id AS account_id,
  count(a.id) FILTER (
    WHERE a.record_status = 'CURRENT' AND aas.counts_toward_quota AND a.transferred_out_at IS NULL
  )::bigint AS used_value
FROM administrative_account aa
LEFT JOIN animal a ON a.account_id = aa.id
LEFT JOIN animal_availability_status aas
  ON aas.code = a.availability_status_code
GROUP BY aa.id;


COMMIT;
