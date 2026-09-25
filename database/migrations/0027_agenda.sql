BEGIN;
INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('AGENDA_TASK_VIEW','TASKS','Consultar tareas','Consultar tareas compartidas o asignadas.'),
 ('AGENDA_TASK_MANAGE','TASKS','Gestionar tareas','Crear, completar y cancelar tareas.'),
 ('AGENDA_EVENT_VIEW','EVENTS','Consultar eventos','Consultar eventos de la propiedad.'),
 ('AGENDA_EVENT_MANAGE','EVENTS','Gestionar eventos','Crear y cancelar eventos.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code IN ('AGENDA_TASK_VIEW','AGENDA_EVENT_VIEW')
 OR (pc.code IN ('AGENDA_TASK_MANAGE','AGENDA_EVENT_MANAGE')
 AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code LIKE 'AGENDA_%'
ON CONFLICT DO NOTHING;
CREATE TABLE agenda_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id uuid NOT NULL REFERENCES property(id),
 kind varchar(8) NOT NULL CHECK(kind IN ('TASK','EVENT')),
 activity_type varchar(60) NOT NULL DEFAULT 'PERSONALIZADA',
 title varchar(180) NOT NULL,
 instructions text CHECK(instructions IS NULL OR length(instructions)<=3000),
 scheduled_at timestamptz NOT NULL,
 reminder_at timestamptz,
 visibility varchar(12) NOT NULL CHECK(visibility IN ('PRIVATE','SELECTED','ALL')),
 status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','CANCELLED')),
 completed_at timestamptz,
 completed_by uuid REFERENCES app_user(id),
 cancelled_at timestamptz,
 cancelled_by uuid REFERENCES app_user(id),
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(reminder_at IS NULL OR reminder_at<=scheduled_at),
 CHECK((status='COMPLETED')=(completed_at IS NOT NULL)),
 CHECK((status='CANCELLED')=(cancelled_at IS NOT NULL)),
 CHECK((completed_at IS NULL)=(completed_by IS NULL)),
 CHECK((cancelled_at IS NULL)=(cancelled_by IS NULL)),
 CHECK(kind='EVENT' OR visibility='SELECTED')
);
CREATE INDEX agenda_item_property_scheduled ON agenda_item(property_id,scheduled_at DESC);
CREATE TABLE agenda_participant (
 item_id uuid NOT NULL REFERENCES agenda_item(id),
 user_id uuid NOT NULL REFERENCES app_user(id),
 response varchar(10) NOT NULL DEFAULT 'PENDING' CHECK(response IN ('PENDING','ACCEPTED','DECLINED')),
 responded_at timestamptz,
 PRIMARY KEY(item_id,user_id)
);
CREATE INDEX agenda_participant_user ON agenda_participant(user_id,item_id);
CREATE TABLE agenda_animal (
 item_id uuid NOT NULL REFERENCES agenda_item(id),
 animal_id uuid NOT NULL REFERENCES animal(id),
 PRIMARY KEY(item_id,animal_id)
);
CREATE FUNCTION protect_agenda_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Los elementos de agenda se cancelan y conservan su historial.' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='agenda_item' AND OLD.status<>'PENDING' THEN
  RAISE EXCEPTION 'El elemento de agenda ya no admite cambios.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agenda_item_protect BEFORE UPDATE OR DELETE ON agenda_item
 FOR EACH ROW EXECUTE FUNCTION protect_agenda_history();
CREATE TRIGGER agenda_participant_protect BEFORE DELETE ON agenda_participant
 FOR EACH ROW EXECUTE FUNCTION protect_agenda_history();
CREATE TRIGGER agenda_animal_protect BEFORE DELETE ON agenda_animal
 FOR EACH ROW EXECUTE FUNCTION protect_agenda_history();
COMMIT;
