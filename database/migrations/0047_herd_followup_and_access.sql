BEGIN;

CREATE VIEW latest_property_animal AS
 SELECT DISTINCT ON (property_id,identity_id) * FROM animal
 WHERE record_status='CURRENT' ORDER BY property_id,identity_id,created_at DESC,id DESC;

ALTER TABLE property_membership ADD COLUMN access_until date;
ALTER TABLE property_invitation ADD COLUMN access_until date;
CREATE INDEX membership_access_expiry ON property_membership(access_until) WHERE status='ACTIVE' AND access_until IS NOT NULL;
CREATE FUNCTION membership_access_valid(member property_membership) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT member.status='ACTIVE' AND (member.access_until IS NULL OR member.access_until >=
   (now() AT TIME ZONE (SELECT timezone FROM property WHERE id=member.property_id))::date);
$$;
CREATE FUNCTION protect_owner_access_until() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.access_until IS NOT NULL AND (EXISTS(SELECT 1 FROM property WHERE id=NEW.property_id AND owner_user_id=NEW.user_id)
   OR EXISTS(SELECT 1 FROM membership_role mr JOIN property_role pr ON pr.id=mr.role_id
    WHERE mr.membership_id=NEW.id AND pr.code='OWNER')) THEN
   RAISE EXCEPTION 'Los propietarios no pueden tener acceso temporal.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_access_until_guard BEFORE INSERT OR UPDATE OF access_until ON property_membership
 FOR EACH ROW EXECUTE FUNCTION protect_owner_access_until();
CREATE FUNCTION expire_property_access(p_user uuid DEFAULT NULL,p_property uuid DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE member record; changed boolean := false;
BEGIN
 FOR member IN SELECT pm.* FROM property_membership pm WHERE pm.status='ACTIVE' AND pm.access_until IS NOT NULL
  AND NOT membership_access_valid(pm) AND (p_user IS NULL OR pm.user_id=p_user)
  AND (p_property IS NULL OR pm.property_id=p_property) FOR UPDATE OF pm SKIP LOCKED LOOP
   UPDATE user_session SET active_property_id=NULL,active_role_id=NULL
     WHERE user_id=member.user_id AND active_property_id=member.property_id AND revoked_at IS NULL AND NOT support_mode;
   UPDATE employment_term SET valid_until=GREATEST(valid_from,member.access_until) WHERE membership_id=member.id AND valid_until IS NULL;
   UPDATE property_membership SET status='ENDED',ended_at=now() WHERE id=member.id;
   INSERT INTO audit_event(property_id,action,entity_type,entity_id,before_data,after_data)
     VALUES(member.property_id,'PROPERTY_ACCESS_EXPIRED','PROPERTY_MEMBERSHIP',member.id,
       jsonb_build_object('accessUntil',member.access_until),'{"status":"ENDED"}');
   changed := true;
 END LOOP;
 RETURN changed;
END $$;

CREATE FUNCTION protect_temporary_owner_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM property_role WHERE id=NEW.role_id AND code='OWNER') AND EXISTS(
   SELECT 1 FROM property_membership WHERE id=NEW.membership_id AND access_until IS NOT NULL) THEN
   RAISE EXCEPTION 'Los propietarios no pueden tener acceso temporal.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER temporary_owner_role_guard BEFORE INSERT OR UPDATE ON membership_role
 FOR EACH ROW EXECUTE FUNCTION protect_temporary_owner_role();

ALTER TABLE livestock_group ADD COLUMN external_phone varchar(50), ADD COLUMN departed_on date,
 ADD COLUMN expected_return_on date, ADD COLUMN external_notes varchar(2000),
 ADD CONSTRAINT group_external_followup CHECK(kind='EXTERNAL' OR
   (external_phone IS NULL AND departed_on IS NULL AND expected_return_on IS NULL AND external_notes IS NULL)),
 ADD CONSTRAINT group_return_after_departure CHECK(departed_on IS NULL OR expected_return_on IS NULL OR expected_return_on>=departed_on);

ALTER TABLE app_notification ADD COLUMN access_event_id bigint REFERENCES audit_event(id),
 ADD COLUMN outside_group_id uuid REFERENCES livestock_group(id), ADD COLUMN return_on date;
ALTER TABLE app_notification DROP CONSTRAINT app_notification_kind_check;
ALTER TABLE app_notification ADD CONSTRAINT app_notification_kind_check CHECK(kind IN
 ('AGENDA_ASSIGNED','AGENDA_COMPLETED','AGENDA_CANCELLED','EXTERNAL_TRANSFER_RECEIVED','EXTERNAL_TRANSFER_DECIDED',
  'ACCESS_CHANGED','EXTERNAL_RETURN_SOON','EXTERNAL_RETURN_DUE'));
CREATE UNIQUE INDEX notification_access_event ON app_notification(user_id,access_event_id) WHERE access_event_id IS NOT NULL;
CREATE UNIQUE INDEX notification_outside_return ON app_notification(user_id,outside_group_id,return_on,kind) WHERE outside_group_id IS NOT NULL;
CREATE OR REPLACE FUNCTION protect_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las notificaciones no se eliminan.' USING ERRCODE='23514'; END IF;
 IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN
   RAISE EXCEPTION 'Solo se permite marcar la notificación como leída.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION notify_access_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE label text; actor text;
BEGIN
 label := CASE NEW.action
  WHEN 'PROPERTY_INVITATION_CREATED' THEN 'Invitación creada'
  WHEN 'PROPERTY_INVITATION_REVOKED' THEN 'Invitación revocada'
  WHEN 'PROPERTY_INVITATION_ACCEPTED' THEN 'Nuevo acceso aceptado'
  WHEN 'PROPERTY_MEMBERSHIP_STATUS_CHANGED' THEN 'Estado de acceso modificado'
  WHEN 'PROPERTY_ROLE_UPDATED' THEN 'Permisos de un rol modificados'
  WHEN 'PROPERTY_ROLE_CREATED' THEN 'Rol personalizado creado'
  WHEN 'PROPERTY_MEMBER_ROLES_UPDATED' THEN 'Roles o vigencia modificados'
  WHEN 'PROPERTY_ACCESS_EXPIRED' THEN 'Acceso temporal finalizado' ELSE NULL END;
 IF label IS NULL THEN RETURN NEW; END IF;
 SELECT display_name INTO actor FROM app_user WHERE id=NEW.actor_user_id;
 INSERT INTO app_notification(user_id,property_id,kind,title,message,access_event_id)
 SELECT DISTINCT pm.user_id,NEW.property_id,'ACCESS_CHANGED',label,
   COALESCE(actor,'El sistema')||': '||label||'. Consulta el equipo y los permisos de la propiedad.',NEW.id
 FROM property_membership pm JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
 JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=pm.property_id AND pr.active AND pr.code='OWNER'
 JOIN app_user u ON u.id=pm.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
 WHERE pm.property_id=NEW.property_id AND membership_access_valid(pm) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER access_change_notification AFTER INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION notify_access_change();

CREATE FUNCTION notify_outside_returns(p_user uuid DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
 INSERT INTO app_notification(user_id,property_id,kind,title,message,outside_group_id,return_on)
 SELECT DISTINCT pm.user_id,g.property_id,
  CASE WHEN g.expected_return_on>(now() AT TIME ZONE p.timezone)::date THEN 'EXTERNAL_RETURN_SOON' ELSE 'EXTERNAL_RETURN_DUE' END,
  CASE WHEN g.expected_return_on>(now() AT TIME ZONE p.timezone)::date THEN 'Regreso previsto mañana' ELSE 'Revisar regreso previsto' END,
  g.name||' · '||g.external_place||' · regreso previsto: '||g.expected_return_on::text,g.id,g.expected_return_on
 FROM livestock_group g JOIN property p ON p.id=g.property_id AND p.status='ACTIVE' AND p.deleted_at IS NULL
 JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
 JOIN property_membership pm ON pm.property_id=p.id AND membership_access_valid(pm)
 JOIN app_user u ON u.id=pm.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
 WHERE g.kind='EXTERNAL' AND g.active AND g.expected_return_on<=(now() AT TIME ZONE p.timezone)::date+1
  AND (p_user IS NULL OR pm.user_id=p_user)
  AND EXISTS(SELECT 1 FROM animal_group_assignment a JOIN animal animal ON animal.id=a.animal_id
    WHERE a.group_id=g.id AND a.ended_at IS NULL AND animal.record_status='CURRENT' AND animal.availability_status_code='ACTIVE')
  AND EXISTS(SELECT 1 FROM membership_role mr JOIN property_role pr ON pr.id=mr.role_id AND pr.active
    JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='GROUP_VIEW'
    WHERE mr.membership_id=pm.id AND mr.property_id=p.id)
 ON CONFLICT DO NOTHING;
$$;
CREATE OR REPLACE FUNCTION validate_session_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.support_mode THEN
    IF NOT EXISTS(SELECT 1 FROM app_user u
      JOIN property p ON p.id=NEW.active_property_id AND p.deleted_at IS NULL
      JOIN property_role pr ON pr.property_id=p.id AND pr.id=NEW.active_role_id
      WHERE u.id=NEW.user_id AND u.is_superadmin AND u.status='ACTIVE' AND u.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'El soporte requiere un superadministrador activo y una propiedad válida.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.active_property_id IS NULL AND NEW.active_role_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.active_property_id IS NULL OR NEW.active_role_id IS NULL THEN
    RAISE EXCEPTION 'La propiedad y el rol activos deben establecerse juntos.' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM property_membership pm
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=pm.property_id AND pr.active
    WHERE pm.user_id=NEW.user_id AND pm.property_id=NEW.active_property_id AND membership_access_valid(pm)
      AND pr.id=NEW.active_role_id) THEN
    RAISE EXCEPTION 'El contexto activo no pertenece al usuario.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
