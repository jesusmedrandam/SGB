# Inicio de la base de datos

## Base creada con el migrador

En una base vacía, las migraciones se ejecutan siempre desde la raíz del
repositorio:

```bash
npm run migrate --workspace @sgb/api
```

El migrador obtiene un bloqueo de PostgreSQL, ejecuta cada archivo dentro de
una transacción y registra su checksum en `schema_migration`. Volver a ejecutar
el comando es seguro: omite archivos ya aplicados y rechaza una migración que
haya sido modificada.

## Base creada manualmente en pgAdmin

Si `0001` a `0006` ya se pegaron manualmente en pgAdmin, **no** se debe ejecutar
el migrador todavía. Primero se abre y ejecuta completo:

```text
database/adopt_manual_migrations.sql
```

Ese archivo:

1. comprueba tablas, vistas, funciones, columnas y disparadores representativos;
2. cancela toda la operación si detecta una migración incompleta;
3. crea `schema_migration`;
4. registra los checksums exactos de `0001` a `0006`;
5. muestra las seis filas registradas al finalizar.

No vuelve a crear tablas ni modifica datos ganaderos. Después de adoptarla, las
migraciones futuras se ejecutan únicamente mediante el migrador.

## Superadministrador inicial

Con `DATABASE_URL` y la configuración SSL de la base disponibles, se definen
temporalmente:

```text
BOOTSTRAP_SUPERADMIN_EMAIL
BOOTSTRAP_SUPERADMIN_PASSWORD
BOOTSTRAP_SUPERADMIN_NAME
```

La contraseña debe tener entre 16 y 128 caracteres. Después se ejecuta una sola
vez:

```bash
npm run bootstrap:superadmin --workspace @sgb/api
```

El comando se niega a crear un segundo superadministrador y tampoco convierte
automáticamente un usuario existente. Al terminar se eliminan inmediatamente
las tres variables `BOOTSTRAP_*` del servicio.
