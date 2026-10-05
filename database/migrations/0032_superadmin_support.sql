BEGIN;

CREATE OR REPLACE FUNCTION validate_session_context() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_property_id IS NULL AND NEW.active_role_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.active_property_id IS NULL OR NEW.active_role_id IS NULL THEN
    RAISE EXCEPTION 'La propiedad y el rol activos deben establecerse juntos.' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM app_user u JOIN property p ON p.id=NEW.active_property_id AND p.deleted_at IS NULL
    JOIN property_role pr ON pr.property_id=p.id AND pr.id=NEW.active_role_id
    WHERE u.id=NEW.user_id AND u.is_superadmin AND u.status='ACTIVE' AND u.deleted_at IS NULL) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM property_membership pm
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=pm.property_id
    WHERE pm.user_id=NEW.user_id AND pm.property_id=NEW.active_property_id
      AND pm.status='ACTIVE' AND pr.id=NEW.active_role_id AND pr.active) THEN
    RAISE EXCEPTION 'El contexto activo no pertenece al usuario.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mark_superadmin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.superadmin_access := NEW.superadmin_access OR EXISTS (
    SELECT 1 FROM app_user WHERE id=NEW.actor_user_id AND is_superadmin);
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_event_mark_superadmin BEFORE INSERT ON audit_event
FOR EACH ROW EXECUTE FUNCTION mark_superadmin_audit();

COMMIT;
