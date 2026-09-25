BEGIN;

INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('COMMERCE_VIEW','SALES_PURCHASES','Consultar ventas y compras','Consultar operaciones comerciales de la propiedad.'),
 ('COMMERCE_MANAGE','SALES_PURCHASES','Gestionar ventas y compras','Registrar y anular operaciones comerciales.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='COMMERCE_VIEW' OR (pc.code='COMMERCE_MANAGE'
 AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('COMMERCE_VIEW','COMMERCE_MANAGE')
ON CONFLICT DO NOTHING;

CREATE TABLE commerce_record (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 property_id uuid NOT NULL,
 kind varchar(10) NOT NULL CHECK(kind IN ('SALE','PURCHASE')),
 traded_on date NOT NULL,
 counterparty_name varchar(180) NOT NULL,
 counterparty_contact varchar(180),
 destination varchar(240),
 currency varchar(3) NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 notes text CHECK(notes IS NULL OR length(notes)<=3000),
 total numeric(14,2) NOT NULL CHECK(total>=0),
 status varchar(12) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CANCELLED')),
 cancelled_at timestamptz,
 cancelled_by uuid REFERENCES app_user(id),
 cancellation_reason text,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(property_id,account_id) REFERENCES property(id,account_id),
 CHECK((status='CANCELLED')=(cancelled_at IS NOT NULL)),
 CHECK((cancelled_at IS NULL)=(cancelled_by IS NULL))
);
CREATE INDEX commerce_record_property_date ON commerce_record(property_id,traded_on DESC,created_at DESC);
CREATE TABLE commerce_line (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 record_id uuid NOT NULL REFERENCES commerce_record(id),
 animal_id uuid REFERENCES animal(id),
 product_name varchar(180),
 quantity numeric(12,3) NOT NULL CHECK(quantity>0),
 unit varchar(40) NOT NULL,
 unit_price numeric(14,2) NOT NULL CHECK(unit_price>=0),
 animal_effect varchar(30) CHECK(animal_effect IN ('KEEP_CURRENT_PROPERTY','EXIT_CURRENT_PROPERTY')),
 exit_event_id uuid REFERENCES animal_status_event(id),
 CHECK((animal_id IS NULL)<>(product_name IS NULL)),
 CHECK(animal_id IS NULL OR (quantity=1 AND unit='ANIMAL')),
 CHECK(animal_id IS NOT NULL OR (animal_effect IS NULL AND exit_event_id IS NULL)),
 CHECK(exit_event_id IS NULL OR animal_effect='EXIT_CURRENT_PROPERTY')
);
CREATE INDEX commerce_line_record ON commerce_line(record_id);
CREATE INDEX commerce_line_animal ON commerce_line(animal_id) WHERE animal_id IS NOT NULL;
CREATE FUNCTION protect_commerce_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Las operaciones comerciales se anulan, no se eliminan.' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='commerce_line' THEN
  RAISE EXCEPTION 'Los detalles comerciales son inmutables.' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>'ACTIVE' OR NEW.status<>'CANCELLED'
  OR NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.property_id<>OLD.property_id
  OR NEW.kind<>OLD.kind OR NEW.traded_on<>OLD.traded_on
  OR NEW.counterparty_name<>OLD.counterparty_name OR NEW.total<>OLD.total
  OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
  OR NEW.currency<>OLD.currency OR NEW.counterparty_contact IS DISTINCT FROM OLD.counterparty_contact
  OR NEW.destination IS DISTINCT FROM OLD.destination OR NEW.notes IS DISTINCT FROM OLD.notes
  OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL
  OR nullif(btrim(NEW.cancellation_reason),'') IS NULL THEN
  RAISE EXCEPTION 'Solo se permite anular una operación activa con un motivo.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_record_protect BEFORE UPDATE OR DELETE ON commerce_record
 FOR EACH ROW EXECUTE FUNCTION protect_commerce_records();
CREATE TRIGGER commerce_line_protect BEFORE UPDATE OR DELETE ON commerce_line
 FOR EACH ROW EXECUTE FUNCTION protect_commerce_records();
COMMIT;
