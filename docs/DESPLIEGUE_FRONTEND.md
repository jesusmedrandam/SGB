# Despliegue del frontend

El frontend es una aplicación estática React/Vite dentro del monorepositorio.
Durante la construcción de SGB 2.0 se debe conservar el frontend anterior como
respaldo y probar esta versión en una vista previa o servicio temporal.

## Variables

```text
VITE_API_URL=https://appsgb.onrender.com
```

La URL se integra en los archivos estáticos durante la compilación. Si cambia,
es necesario volver a desplegar.

## Configuración del Static Site en Render

- Repositorio: `jesusmedrandam/SGB`
- Rama: `foundation/sgb-v2`
- Root Directory: vacío
- Build Command: `npm ci --include=dev && npm run build --workspace @sgb/web`
- Publish Directory: `apps/web/dist`

Antes del cambio definitivo, la API debe tener como `FRONTEND_URL` la dirección
exacta desde la que se probará el sitio. Para producción será
`https://medranda.onrender.com`.

## Correo de verificación

En el servicio de la API configura:

```text
BREVO_API_KEY=tu_clave_api_de_brevo
BREVO_SENDER_EMAIL=remitente-verificado@tu-dominio.com
BREVO_SENDER_NAME=SGB
```

Debe usarse una clave de API, no una clave SMTP. El correo del remitente debe
estar verificado en Brevo. No agregues estas variables al sitio estático ni al
repositorio; pertenecen únicamente al servidor de la API.

## Sesiones

- El token de acceso se conserva únicamente en memoria.
- El navegador recupera la sesión mediante la cookie `HttpOnly` de renovación.
- El token de acceso se renueva antes de expirar.
- El identificador local distingue las sesiones de cada dispositivo.
- Al cerrar sesión, el servidor revoca los tokens y elimina la cookie.
