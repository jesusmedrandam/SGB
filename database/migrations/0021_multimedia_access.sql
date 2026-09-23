BEGIN;
INSERT INTO permission_catalog(code,module_code,name,description) VALUES
 ('MEDIA_VIEW','MULTIMEDIA','Consultar multimedia','Consultar adjuntos de la propiedad.'),
 ('MEDIA_MANAGE','MULTIMEDIA','Gestionar multimedia','Cargar y quitar adjuntos de la propiedad.');
INSERT INTO role_template_permission(role_code,permission_code)
SELECT rt.code,pc.code FROM role_template rt CROSS JOIN permission_catalog pc
WHERE pc.code='MEDIA_VIEW' OR (pc.code='MEDIA_MANAGE'
 AND rt.code IN ('OWNER','ADMINISTRATOR','OPERATOR'));
INSERT INTO role_permission(role_id,permission_code)
SELECT pr.id,rtp.permission_code FROM property_role pr
JOIN role_template_permission rtp ON rtp.role_code=pr.code
WHERE pr.is_system AND rtp.permission_code IN ('MEDIA_VIEW','MEDIA_MANAGE')
ON CONFLICT DO NOTHING;
COMMIT;
