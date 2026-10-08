BEGIN;

CREATE TABLE email_change_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  previous_email citext NOT NULL,
  new_email citext NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_change_token_user ON email_change_token(user_id) WHERE consumed_at IS NULL;

ALTER TABLE health_medicine ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE health_medicine ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE FUNCTION touch_health_medicine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER health_medicine_version BEFORE UPDATE ON health_medicine
FOR EACH ROW EXECUTE FUNCTION touch_health_medicine();

ALTER TABLE health_campaign ADD COLUMN medicine_snapshot jsonb;
ALTER TABLE health_campaign DISABLE TRIGGER health_campaign_protect;
UPDATE health_campaign c SET medicine_snapshot = to_jsonb(m) - 'account_id' - 'created_by'
FROM health_medicine m WHERE m.id = c.medicine_id;
ALTER TABLE health_campaign ENABLE TRIGGER health_campaign_protect;
ALTER TABLE health_campaign ALTER COLUMN medicine_snapshot SET NOT NULL;
CREATE FUNCTION snapshot_health_medicine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.medicine_id <> OLD.medicine_id
     OR (OLD.status = 'BORRADOR' AND NEW.status = 'COMPLETADO') THEN
    SELECT to_jsonb(m) - 'account_id' - 'created_by' INTO NEW.medicine_snapshot
    FROM health_medicine m WHERE m.id = NEW.medicine_id;
  ELSE
    NEW.medicine_snapshot := OLD.medicine_snapshot;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER health_campaign_snapshot BEFORE INSERT OR UPDATE ON health_campaign
FOR EACH ROW EXECUTE FUNCTION snapshot_health_medicine();

COMMIT;
