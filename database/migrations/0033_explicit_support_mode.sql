BEGIN;

ALTER TABLE user_session
  ADD COLUMN support_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN support_return_property_id uuid REFERENCES property(id),
  ADD COLUMN support_return_role_id uuid REFERENCES property_role(id);

-- Old sessions inferred support from identity; retain only actual memberships as user contexts.
UPDATE user_session s SET active_property_id=NULL,active_role_id=NULL
WHERE EXISTS(SELECT 1 FROM app_user u WHERE u.id=s.user_id AND u.is_superadmin)
  AND s.active_property_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM property_membership pm
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=pm.property_id AND pr.active
    JOIN property p ON p.id=pm.property_id AND p.status='ACTIVE' AND p.deleted_at IS NULL
    JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
    WHERE pm.user_id=s.user_id AND pm.property_id=s.active_property_id AND pm.status='ACTIVE'
      AND pr.id=s.active_role_id
  );

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
    WHERE pm.user_id=NEW.user_id AND pm.property_id=NEW.active_property_id AND pm.status='ACTIVE'
      AND pr.id=NEW.active_role_id) THEN
    RAISE EXCEPTION 'El contexto activo no pertenece al usuario.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER user_session_validate_context ON user_session;
CREATE TRIGGER user_session_validate_context
BEFORE INSERT OR UPDATE OF user_id,active_property_id,active_role_id,support_mode ON user_session
FOR EACH ROW EXECUTE FUNCTION validate_session_context();

CREATE OR REPLACE FUNCTION mark_superadmin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.superadmin_access := NEW.superadmin_access
    OR COALESCE(current_setting('sgb.superadmin_support',true)='true',false);
  RETURN NEW;
END;
$$;

COMMIT;
