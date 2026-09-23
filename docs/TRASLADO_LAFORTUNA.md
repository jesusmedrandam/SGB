# Traslado del sistema anterior (lafortuna)

La fuente de consulta es el repositorio `lafortuna`. Todos los cambios se hacen
en SGB, rama `foundation/sgb-v2`; no se modifica el sistema anterior. Se
trasladan reglas, consultas y pantallas por procesos completos. Las rutas SQL
anteriores no se ejecutan sobre SGB: sus tablas (`propiedad_ganadera`, `grupo`,
`ubicacion`, `celo`, `prenez`, `parto`) usan otros identificadores y no aplican
el aislamiento por cuenta, propiedad, rol y módulos de SGB.

## Equivalencias permanentes

| Anterior | SGB nuevo |
| --- | --- |
| `propiedad_ganadera.id_propiedad` | `property.id`, `administrative_account.id` |
| `usuario` y permisos del proyecto único | `app_user`, `property_membership`, `property_role`, `role_permission` |
| `animal.id_animal` | `animal.id`, `account_id`, `property_id` |
| `grupo` y ubicación actual | `livestock_group`, `physical_location`, asignaciones con historial |
| `celo`, `prenez`, `parto`, `aborto` | `reproduction_heat`, `reproduction_pregnancy`, `reproduction_birth`, `reproduction_loss` |
| `servicio_reproductivo` | `reproduction_service` enlazado a `reproduction_pregnancy` |
| `lactancia`, `produccion_leche`, `produccion_tanque` | `milk_lactation`, `milk_production`, `milk_tank_production` |
| `configuracion_propiedad` reproductiva | `reproduction_setting` por propiedad |

## Estado por proceso

| Proceso anterior | Situación en SGB | Archivos de referencia en lafortuna |
| --- | --- | --- |
| Acceso, usuarios, roles y propiedades | Adaptados al modelo de cuentas de SGB | `src/modules/auth`, `admin`, `properties`, `settings` |
| Animales, razas, colores, padres, propietarios y marquillas | Incorporados con catálogos globales y opciones por cuenta | `src/modules/animals`, `catalogs`, `marks` |
| Grupos, potreros y corrales | Incorporados con historial de ubicación y requisitos de módulos | `src/modules/groups`, `locations` |
| Celos, preñeces, partos y pérdidas | Incorporados; crías, parentesco, propietarios, reglas por propiedad y auditoría | `src/modules/reproduction/reproduction.routes.ts`, `src/services/reproduction-policy.ts`, `frontend/src/pages/reproduction` |
| Servicios asistidos, lactancias, ordeño y tanque | Incorporados con límite posparto configurable y ordeño independiente de lactancia tras un parto; pendientes edición de registros y gráficas avanzadas | `src/modules/reproduction`, `records`, `frontend/src/pages/production` |
| Movimientos detallados y asistencia animal | Pendientes; conservar historial de grupo y ubicación | `src/modules/movements`, `frontend/src/pages/operations/MovementsPage.tsx` |
| Sanidad, tratamientos, limpiezas y actividades | Pendientes; registrar eventos y consumos de cada propiedad | `src/modules/sanitary`, `health`, `cleanings`, `activities` |
| Ventas, compras y finanzas personales | Pendientes; ventas deben conservar efectos sobre disponibilidad del animal | `src/modules/sales`, `purchases`, `personal-finance` |
| Agenda, notificaciones y panel de control | Pendientes; se apoyan en los registros anteriores | `src/modules/agenda`, `notifications`, `dashboard` |
| Imágenes y uso sin conexión | Tipos de entidad preparados para los eventos reproductivos y de producción; pendientes carga, validación, visualización y sincronización | `src/modules/images`, `frontend/src/pages/multimedia`, `offline` |

Para cada proceso: aprovechar sus reglas y flujos del anterior; usar tablas,
cuotas, permisos y módulos de SGB; agregar migración nueva y prueba de
integración que cubra las relaciones entre cuentas. `npm run migrate --workspace
@sgb/api` aplica las migraciones en orden; no hace falta pegar SQL a mano.
