# SGB

Nueva generación del Sistema de Gestión Bovina. Este repositorio se desarrolla
en paralelo a `jesusmedrandam/lafortuna`; el sistema anterior permanece intacto
hasta completar las pruebas y la migración voluntaria.

## Principios

- Seguridad y auditoría desde la primera migración.
- Separación estricta de datos por propiedad.
- Funcionamiento offline como requisito, no como añadido posterior.
- Una persona puede administrar propiedades propias y colaborar en propiedades ajenas.
- La propiedad y el rol activos forman parte del contexto de cada operación.
- Ningún módulo desactivado elimina información histórica.

## Estructura

- `apps/api`: API modular en Node.js y TypeScript.
- `apps/web`: aplicación web/PWA en React.
- `packages/contracts`: contratos compartidos entre API, web y Android.
- `database/migrations`: migraciones PostgreSQL inmutables.
- `docs`: reglas funcionales y decisiones de arquitectura.

Las reglas de especies, catálogos y unidades están documentadas en
[`docs/CATALOGOS.md`](docs/CATALOGOS.md).
El modelo inicial de autenticación y selección de contexto está en
[`docs/ACCESO_Y_CONTEXTO.md`](docs/ACCESO_Y_CONTEXTO.md).

## Estado

Fase 0: arquitectura fundacional. Todavía no debe desplegarse como reemplazo del
sistema actual.

## Desarrollo

Requiere Node.js 22 LTS.

```bash
npm install
npm run typecheck
npm run build
npm test
npm run audit:prod
```

Para aplicar migraciones en orden y verificar que ninguna migración histórica
haya sido alterada:

```bash
npm run migrate --workspace @sgb/api
```

Las credenciales se configuran mediante variables de entorno. Nunca deben
guardarse contraseñas, tokens, archivos `.env` ni claves de Firebase en Git.
