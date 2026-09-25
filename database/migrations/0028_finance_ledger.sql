BEGIN;
INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('FINANCE_VIEW','PROPERTY_FINANCE','Consultar ingresos y egresos','Consultar finanzas de la propiedad.'),
 ('FINANCE_MANAGE','PROPERTY_FINANCE','Gestionar ingresos y egresos','Registrar cuentas y movimientos de la propiedad.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='FINANCE_VIEW' OR (pc.code='FINANCE_MANAGE'
 AND rt.code IN ('OWNER','ADMINISTRATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('FINANCE_VIEW','FINANCE_MANAGE')
ON CONFLICT DO NOTHING;
CREATE TABLE finance_account (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 scope varchar(8) NOT NULL CHECK(scope IN ('PROPERTY','PERSONAL')),
 property_id uuid REFERENCES property(id),
 user_id uuid REFERENCES app_user(id),
 name varchar(160) NOT NULL,
 kind varchar(24) NOT NULL CHECK(kind IN ('CASH','BANK','WALLET','CREDIT_CARD','OTHER')),
 opening_balance numeric(14,2) NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((scope='PROPERTY' AND property_id IS NOT NULL AND user_id IS NULL)
    OR (scope='PERSONAL' AND property_id IS NULL AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX finance_account_property_name ON finance_account(property_id,lower(name))
 WHERE scope='PROPERTY';
CREATE UNIQUE INDEX finance_account_user_name ON finance_account(user_id,lower(name))
 WHERE scope='PERSONAL';
CREATE TABLE finance_movement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 scope varchar(8) NOT NULL CHECK(scope IN ('PROPERTY','PERSONAL')),
 property_id uuid REFERENCES property(id),
 user_id uuid REFERENCES app_user(id),
 kind varchar(10) NOT NULL CHECK(kind IN ('INCOME','EXPENSE','TRANSFER')),
 source_account_id uuid REFERENCES finance_account(id),
 destination_account_id uuid REFERENCES finance_account(id),
 amount numeric(14,2) NOT NULL CHECK(amount>0),
 occurred_on date NOT NULL,
 category varchar(120),
 concept varchar(240) NOT NULL,
 notes text CHECK(notes IS NULL OR length(notes)<=3000),
 cancelled_at timestamptz,
 cancelled_by uuid REFERENCES app_user(id),
 cancellation_reason text,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((scope='PROPERTY' AND property_id IS NOT NULL AND user_id IS NULL)
    OR (scope='PERSONAL' AND property_id IS NULL AND user_id IS NOT NULL)),
 CHECK((kind='INCOME' AND source_account_id IS NULL AND destination_account_id IS NOT NULL)
    OR (kind='EXPENSE' AND source_account_id IS NOT NULL AND destination_account_id IS NULL)
    OR (kind='TRANSFER' AND source_account_id IS NOT NULL AND destination_account_id IS NOT NULL
     AND source_account_id<>destination_account_id)),
 CHECK((cancelled_at IS NULL)=(cancelled_by IS NULL))
);
CREATE INDEX finance_movement_property_date ON finance_movement(property_id,occurred_on DESC);
CREATE INDEX finance_movement_user_date ON finance_movement(user_id,occurred_on DESC);
CREATE FUNCTION protect_finance_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin finance_account%ROWTYPE; target finance_account%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Los movimientos financieros se anulan; no se eliminan.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NEW.cancelled_by IS NULL
    OR nullif(btrim(NEW.cancellation_reason),'') IS NULL
    OR NEW.id<>OLD.id OR NEW.scope<>OLD.scope OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.kind<>OLD.kind
    OR NEW.source_account_id IS DISTINCT FROM OLD.source_account_id
    OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
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
CREATE TRIGGER finance_movement_protect BEFORE INSERT OR UPDATE OR DELETE ON finance_movement
 FOR EACH ROW EXECUTE FUNCTION protect_finance_movement();
CREATE FUNCTION protect_finance_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Las cuentas financieras se desactivan.' USING ERRCODE='23514'; END IF;
 IF NEW.id<>OLD.id OR NEW.scope<>OLD.scope OR NEW.property_id IS DISTINCT FROM OLD.property_id
  OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.opening_balance<>OLD.opening_balance
  OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'El origen y el saldo inicial son inmutables.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finance_account_protect BEFORE UPDATE OR DELETE ON finance_account
 FOR EACH ROW EXECUTE FUNCTION protect_finance_account();
COMMIT;
