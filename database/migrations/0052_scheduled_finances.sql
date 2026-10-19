BEGIN;
ALTER TABLE finance_movement ADD COLUMN scheduled_on date,
 ADD COLUMN effective_at timestamptz DEFAULT now();
ALTER TABLE finance_movement ADD CONSTRAINT finance_schedule_valid CHECK
 ((scheduled_on IS NULL AND effective_at IS NOT NULL) OR (scheduled_on IS NOT NULL AND kind IN ('INCOME','EXPENSE')));
CREATE INDEX finance_pending_date ON finance_movement(scheduled_on) WHERE effective_at IS NULL AND cancelled_at IS NULL;
CREATE OR REPLACE FUNCTION protect_finance_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin finance_account%ROWTYPE; target finance_account%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Los movimientos financieros se anulan; no se eliminan.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.scheduled_on IS NOT NULL AND OLD.effective_at IS NULL
   AND OLD.cancelled_at IS NULL AND NEW.effective_at IS NOT NULL THEN
  IF (to_jsonb(NEW)-'effective_at'-'occurred_on') IS DISTINCT FROM (to_jsonb(OLD)-'effective_at'-'occurred_on')
    OR NEW.occurred_on<OLD.scheduled_on THEN
   RAISE EXCEPTION 'Solo se permite hacer efectivo el pago o cobro programado.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NEW.cancelled_by IS NULL
    OR nullif(btrim(NEW.cancellation_reason),'') IS NULL
    OR NEW.id<>OLD.id OR NEW.scope<>OLD.scope OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.kind<>OLD.kind
    OR NEW.source_account_id IS DISTINCT FROM OLD.source_account_id
    OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
    OR NEW.scheduled_on IS DISTINCT FROM OLD.scheduled_on OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
    OR NEW.amount<>OLD.amount OR NEW.occurred_on<>OLD.occurred_on
    OR NEW.category IS DISTINCT FROM OLD.category OR NEW.concept<>OLD.concept
    OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.created_by<>OLD.created_by
    OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'Solo se permite anular el movimiento con un motivo.' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.source_account_id IS NOT NULL THEN
   SELECT * INTO origin FROM finance_account WHERE id=NEW.source_account_id;
   IF origin.scope IS DISTINCT FROM NEW.scope OR origin.property_id IS DISTINCT FROM NEW.property_id
     OR origin.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'La cuenta origen pertenece a otro ámbito.' USING ERRCODE='23514';
   END IF;
  END IF;
  IF NEW.destination_account_id IS NOT NULL THEN
   SELECT * INTO target FROM finance_account WHERE id=NEW.destination_account_id;
   IF target.scope IS DISTINCT FROM NEW.scope OR target.property_id IS DISTINCT FROM NEW.property_id
     OR target.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'La cuenta destino pertenece a otro ámbito.' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE app_notification ADD COLUMN finance_movement_id uuid REFERENCES finance_movement(id);
ALTER TABLE app_notification ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE app_notification ADD CONSTRAINT notification_property_or_finance CHECK(property_id IS NOT NULL OR finance_movement_id IS NOT NULL);
ALTER TABLE app_notification DROP CONSTRAINT app_notification_kind_check;
ALTER TABLE app_notification ADD CONSTRAINT app_notification_kind_check CHECK(kind IN
 ('AGENDA_ASSIGNED','AGENDA_COMPLETED','AGENDA_CANCELLED','EXTERNAL_TRANSFER_RECEIVED','EXTERNAL_TRANSFER_DECIDED',
  'ACCESS_CHANGED','EXTERNAL_RETURN_SOON','EXTERNAL_RETURN_DUE','FINANCE_DUE'));
CREATE UNIQUE INDEX notification_finance_due ON app_notification(user_id,finance_movement_id,kind) WHERE finance_movement_id IS NOT NULL;
CREATE FUNCTION can_view_finance_reminder(p_movement uuid,p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM finance_movement m JOIN app_user u ON u.id=p_user AND u.status='ACTIVE' AND u.deleted_at IS NULL
 WHERE m.id=p_movement AND ((m.scope='PERSONAL' AND m.user_id=p_user AND EXISTS
  (SELECT 1 FROM effective_user_module WHERE user_id=p_user AND module_code='PERSONAL_FINANCE' AND enabled)) OR
  (m.scope='PROPERTY' AND EXISTS(SELECT 1 FROM property p
   JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
   JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=p_user AND membership_access_valid(pm)
   JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
   JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
   JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='FINANCE_VIEW'
   JOIN effective_property_module epm ON epm.property_id=p.id AND epm.module_code='PROPERTY_FINANCE' AND epm.enabled
   WHERE p.id=m.property_id AND p.status='ACTIVE' AND p.deleted_at IS NULL))))
$$;
CREATE FUNCTION notify_finance_due(p_user uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO app_notification(user_id,property_id,kind,title,message,finance_movement_id)
 SELECT p_user,m.property_id,'FINANCE_DUE',CASE WHEN m.kind='INCOME' THEN 'Cobro pendiente' ELSE 'Pago pendiente' END,
  m.concept||' · fecha prevista: '||m.scheduled_on::text||'. Confirma cuando se haga efectivo.',m.id
 FROM finance_movement m LEFT JOIN property p ON p.id=m.property_id
 WHERE m.effective_at IS NULL AND m.cancelled_at IS NULL
  AND m.scheduled_on<=(now() AT TIME ZONE coalesce(p.timezone,'America/Guayaquil'))::date
  AND can_view_finance_reminder(m.id,p_user) ON CONFLICT DO NOTHING
$$;
COMMIT;
