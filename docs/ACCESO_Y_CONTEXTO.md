# Acceso y contexto activo

## Registro inicial

El registro con intención de administrar una finca crea en una sola transacción:

1. usuario pendiente de verificar;
2. cuenta administrativa con límite inicial de una propiedad;
3. primera propiedad;
4. módulos permitidos para cuenta, propiedad y usuario;
5. especie bovina habilitada;
6. roles de sistema de la propiedad;
7. membresía y rol de propietario;
8. token de verificación almacenado únicamente como hash;
9. evento de auditoría.

Un fallo revierte la operación completa. No quedan usuarios, propiedades o
permisos incompletos.

## Sesiones

- El token de acceso es opaco, aleatorio y dura 15 minutos por defecto.
- El token de renovación es opaco, rota en cada uso y se entrega mediante cookie
  `HttpOnly`.
- La base de datos guarda solamente hashes SHA-256 de ambos tokens.
- Solo puede existir una sesión abierta por usuario y `deviceId`.
- Cerrar sesión o iniciar nuevamente en el mismo dispositivo revoca la anterior.
- Cinco contraseñas incorrectas bloquean temporalmente la cuenta por 15 minutos.
- El pool de PostgreSQL está limitado; toda transacción libera su conexión.

## Superadministrador

El superadministrador no puede crearse ni promoverse desde el registro público.
Se inicializa una sola vez con:

```bash
npm run bootstrap:superadmin --workspace @sgb/api
```

El comando exige las variables `BOOTSTRAP_SUPERADMIN_EMAIL`,
`BOOTSTRAP_SUPERADMIN_PASSWORD` y `BOOTSTRAP_SUPERADMIN_NAME`. Si ya existe un
superadministrador no modifica nada. Las variables deben retirarse del servicio
después de ejecutar el comando.

## Propiedad y rol activos

Una sesión puede tener una propiedad y un rol activos. Ambos valores se validan
contra una membresía activa y deben pertenecer a la misma propiedad. Cambiar el
contexto no suma permisos de otros roles.

Los middlewares de operaciones vuelven a consultar:

- membresía y rol vigentes;
- permisos del rol;
- módulos habilitados por cuenta y propiedad;
- especies habilitadas por cuenta y propiedad.

Por ello, cambiar manualmente identificadores en una solicitud no concede acceso.

## Verificación de correo

SGB envía el enlace de activación mediante la API transaccional de Brevo. En el
servidor deben configurarse `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` y,
opcionalmente, `BREVO_SENDER_NAME`. El remitente debe existir y estar verificado
en Brevo. El enlace utiliza `FRONTEND_URL` y vence en 24 horas por defecto.

El reenvío responde siempre de forma genérica para no revelar si un correo está
registrado, se limita por dirección IP y aplica una espera mínima entre tokens.
Solicitar uno nuevo invalida los enlaces anteriores.

Una instalación no productiva puede devolver el token con
`EXPOSE_AUTH_TOKENS=true`. Esta opción queda deshabilitada automáticamente en
producción y nunca sustituye el envío de correo.

## Rutas iniciales

| Método | Ruta | Función |
| --- | --- | --- |
| `POST` | `/auth/register` | Crea usuario, cuenta y primera propiedad |
| `POST` | `/auth/resend-verification` | Solicita otro correo sin revelar cuentas existentes |
| `POST` | `/auth/verify-email` | Activa el correo mediante token de un solo uso |
| `POST` | `/auth/login` | Abre una sesión por dispositivo |
| `POST` | `/auth/refresh` | Rota los tokens de la sesión |
| `POST` | `/auth/logout` | Revoca la sesión |
| `GET` | `/auth/me` | Devuelve propiedades, roles y módulos disponibles |
| `POST` | `/auth/context` | Cambia la propiedad y el rol activos |

Las migraciones se ejecutan con un bloqueo asesor de PostgreSQL y conservan el
checksum de cada archivo. Dos despliegues no pueden migrar simultáneamente y un
archivo ya aplicado no puede reescribirse sin que el proceso se detenga.
