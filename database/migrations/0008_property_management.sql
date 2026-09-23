BEGIN;

INSERT INTO permission_catalog(code, module_code, name, description)
VALUES ('PROPERTY_CREATE', 'CORE', 'Crear propiedades', 'Crear propiedades dentro del límite de la cuenta.');

INSERT INTO role_template_permission(role_code, permission_code)
VALUES ('OWNER', 'PROPERTY_CREATE'), ('ADMINISTRATOR', 'PROPERTY_CREATE');

INSERT INTO role_permission(role_id, permission_code)
SELECT pr.id, 'PROPERTY_CREATE'
FROM property_role pr
WHERE pr.code IN ('OWNER', 'ADMINISTRATOR')
ON CONFLICT DO NOTHING;

COMMIT;
