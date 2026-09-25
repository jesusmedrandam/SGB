BEGIN;
CREATE TABLE app_notification (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES app_user(id),
 property_id uuid NOT NULL REFERENCES property(id),
 agenda_item_id uuid REFERENCES agenda_item(id),
 kind varchar(32) NOT NULL CHECK(kind IN ('AGENDA_ASSIGNED','AGENDA_COMPLETED','AGENDA_CANCELLED')),
 title varchar(180) NOT NULL,
 message text NOT NULL,
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,agenda_item_id,kind)
);
CREATE INDEX app_notification_user_time ON app_notification(user_id,created_at DESC);
CREATE FUNCTION protect_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las notificaciones no se eliminan.' USING ERRCODE='23514'; END IF;
 IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.id<>OLD.id
  OR NEW.user_id<>OLD.user_id OR NEW.property_id<>OLD.property_id
  OR NEW.agenda_item_id IS DISTINCT FROM OLD.agenda_item_id OR NEW.kind<>OLD.kind
  OR NEW.title<>OLD.title OR NEW.message<>OLD.message OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Solo se permite marcar la notificación como leída.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_protect BEFORE UPDATE OR DELETE ON app_notification
 FOR EACH ROW EXECUTE FUNCTION protect_notification();
COMMIT;
