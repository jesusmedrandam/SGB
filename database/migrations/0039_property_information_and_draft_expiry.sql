BEGIN;
ALTER TABLE property ADD COLUMN owner_name varchar(160), ADD COLUMN area_value numeric(14,4),
 ADD COLUMN area_unit_code varchar(30) REFERENCES measurement_unit(code), ADD COLUMN address varchar(500),
 ADD CONSTRAINT property_area_pair CHECK ((area_value IS NULL)=(area_unit_code IS NULL)),
 ADD CONSTRAINT property_area_positive CHECK (area_value>0),
 ADD CONSTRAINT property_area_unit CHECK (area_unit_code IN ('HECTARE','SQUARE_METER'));
ALTER TABLE livestock_movement ADD COLUMN expired_at timestamptz;
CREATE INDEX livestock_movement_draft_expiry ON livestock_movement(created_at) WHERE status='BORRADOR' AND expired_at IS NULL;
ALTER TABLE health_campaign ADD COLUMN expired_at timestamptz;
CREATE INDEX health_campaign_draft_expiry ON health_campaign(created_at) WHERE status='BORRADOR' AND expired_at IS NULL;
ALTER TABLE pasture_cleaning ADD COLUMN expired_at timestamptz;
CREATE INDEX pasture_cleaning_draft_expiry ON pasture_cleaning(created_at) WHERE status='BORRADOR' AND expired_at IS NULL;
ALTER TABLE livestock_activity ADD COLUMN expired_at timestamptz;
CREATE INDEX livestock_activity_draft_expiry ON livestock_activity(created_at) WHERE status='BORRADOR' AND expired_at IS NULL;
CREATE FUNCTION expire_unapplied_drafts() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE spec record; affected integer; total integer:=0;
BEGIN
 FOR spec IN SELECT * FROM (VALUES
 ('livestock_movement','source_property_id','CANCELADO','MOVEMENT_DRAFT_EXPIRED','LIVESTOCK_MOVEMENT'),
 ('health_campaign','property_id','CANCELADO','HEALTH_CAMPAIGN_DRAFT_EXPIRED','HEALTH_CAMPAIGN'),
 ('pasture_cleaning','property_id','CANCELADO','CLEANING_DRAFT_EXPIRED','CLEANING'),
 ('livestock_activity','property_id','CANCELADA','ACTIVITY_DRAFT_EXPIRED','LIVESTOCK_ACTIVITY')
 ) AS definitions(table_name,property_column,cancelled_status,action,entity_type)
 LOOP
  EXECUTE format('WITH candidates AS (SELECT t.* FROM %I t WHERE status=''BORRADOR'' AND expired_at IS NULL
   AND created_at<=now()-interval ''24 hours'' FOR UPDATE SKIP LOCKED), changed AS (
   UPDATE %I t SET status=$1,cancelled_at=now(),expired_at=now() FROM candidates old WHERE t.id=old.id
   RETURNING t.id,old.%I AS property_id,to_jsonb(old) AS before_data,to_jsonb(t) AS after_data)
   INSERT INTO audit_event(property_id,action,entity_type,entity_id,before_data,after_data,reason)
   SELECT property_id,$2,$3,id::text,before_data,after_data,''Borrador eliminado automáticamente tras 24 horas sin aplicar.'' FROM changed',
   spec.table_name,spec.table_name,spec.property_column) USING spec.cancelled_status,spec.action,spec.entity_type;
  GET DIAGNOSTICS affected=ROW_COUNT;total:=total+affected;
 END LOOP;
 RETURN total;
END; $$;
COMMIT;
