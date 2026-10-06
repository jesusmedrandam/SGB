# Medicamentos y vías compartidos por cuenta

La migración `0034_medicine_routes_and_weight_doses.sql` permite ampliar las vías
de administración desde Catálogos. Conserva las seis vías oficiales y los
medicamentos existentes. Las vías y medicamentos propios se comparten entre
las propiedades de la cuenta; las cuentas ajenas quedan aisladas.

`GET /catalogs/medicines` requiere `CATALOG_VIEW`; `POST` requiere
`CATALOG_MANAGE`, comprobado otra vez dentro de la transacción. Las rutas
de `/health-records/medicines` conservan sus permisos de Sanidad.
Las altas estructuradas usan `/health-records/medicines/structured`, para que
una API anterior rechace el envío y conserve el pendiente en vez de omitir sus
campos nuevos. El endpoint anterior sigue disponible para versiones previas.

El uso principal (`kind`) distingue vacunación, desparasitación, tratamiento de
enfermedad y otros usos. `treatmentCatalogItemId` señala la clase farmacológica.
`administrationRoutes` contiene códigos oficiales o identificadores de vías
propias activas. Los tratamientos solo admiten vías del medicamento y la cuenta.

`doseAmount` utiliza `defaultUnitCode`. Una referencia fija omite `doseWeight`
y `doseWeightUnitCode`. Una referencia por peso completa ambos campos con
kilogramos o libras. La app calcula cantidad × peso del animal / peso base;
el tratamiento siempre guarda la cantidad realmente aceptada por el usuario.
El texto anterior de `suggestedDose` se conserva, sin interpretar texto libre.

`/health-records/options` devuelve el último pesaje no anulado, convertido a kg,
o el peso inicial y su origen. Sin peso disponible, la dosis se introduce
manualmente. Las listas descargadas y las altas pendientes funcionan offline.

Despliegue: compilar y ejecutar las migraciones antes de iniciar la API. El
comando actual de Render (`node apps/api/dist/scripts/migrate.js && npm run start
--workspace @sgb/api`) ya realiza estos pasos. `/health` anuncia
`medicine-weight-dose` y `/health/ready` devuelve `medicineDosesReady: true`.

Validación: migración sobre las 33 migraciones anteriores, once pruebas de
integración, aislamiento y permisos, vías personalizadas, pesajes anulados,
conversión de libras, persistencia de referencia y auditoría del autor.

## Referencias por clasificación (0035)

`doseClassificationRanges` permite configurar un mínimo y máximo para cada
clasificación existente (VACA, VACONA, TERNERA, TORO, TORETE o TERNERO). Se usan
los nombres personalizados y la clasificación calculada del inventario.
Los rangos se excluyen de la referencia fija o por peso y no admiten
clasificaciones repetidas, cantidades no positivas ni máximos menores al mínimo.
El tratamiento muestra el intervalo y requiere aceptar una cantidad manual;
no elige automáticamente un extremo. Una cantidad diferente también es válida.
Sin peso, se muestra la configuración conservada del medicamento.

Las altas con rangos usan `/health-records/medicines/classification` o
`/catalogs/medicines/classification`. Una API anterior rechazará estas rutas;
el pendiente se conserva y nunca se descartan los rangos silenciosamente.
La migración `0035_medicine_classification_doses.sql` añade una columna JSONB
con valor inicial vacío para todos los medicamentos existentes. Mantiene los
permisos, el aislamiento por cuenta y la auditoría del autor real.
`/health/ready` informa `medicineClassificationDosesReady`.

Android alpha.9 usa el mismo formulario en Sanidad y Catálogos, exige seleccionar
una unidad y dispone de las seis unidades oficiales aunque la descarga sea
anterior. Catálogos incluye «Unidades de dosis». Una actualización del caché
refresca los registros sanitarios sin reiniciar el formulario abierto.
