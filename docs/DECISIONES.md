# Decisiones confirmadas

Fecha de corte: 2026-09-21.

## Identidad y administración

1. Existe un único rol de plataforma `SUPERADMIN`.
   La persona superadministradora también puede poseer una cuenta y propiedades;
   el rol global no reemplaza sus roles activos dentro de cada finca.
2. Cualquier persona puede registrarse y crear inmediatamente su primera propiedad.
3. Al crear su primera propiedad obtiene todos los módulos habilitados.
4. Una cuenta nueva puede tener inicialmente una propiedad.
5. El superadministrador puede cambiar el límite de propiedades de cada cuenta.
6. Cada propiedad tiene un único propietario y puede tener varios administradores.
7. Un administrador puede ser colaborador en propiedades de otros propietarios.
8. Un usuario puede pertenecer a varias propiedades y tener varios roles en cada una.
9. Si tiene varios roles, el usuario elige un solo rol activo. Los permisos no se suman.

## Propiedad activa

- La aplicación tendrá un selector global y persistente de propiedad y rol.
- Las altas y modificaciones siempre operan sobre una sola propiedad activa.
- La opción «Todas» solo se permitirá en paneles, resúmenes, alertas e informes autorizados.
- Los movimientos entre propiedades elegirán origen y destino explícitamente.

## Módulos

- El superadministrador define el máximo de módulos disponible para una cuenta.
- Cada propiedad puede desactivar un módulo permitido para la cuenta.
- Una propiedad nunca puede activar un módulo bloqueado para su cuenta.
- Desactivar un módulo conserva todos sus datos.
- `MULTI_PROPERTY` tiene además el límite numérico `max_properties`.

## Privacidad y auditoría

- El superadministrador puede consultar toda la información.
- Cada acceso o modificación administrativa queda registrado en auditoría.
- «Mis finanzas» pertenece exclusivamente al usuario; no cambia al seleccionar propiedad.
- Su disponibilidad se configura para el usuario, no para una propiedad.
- Los administradores de una propiedad no pueden consultar las finanzas personales.
- El cargo y pago de un colaborador pertenecen a su membresía en cada propiedad.

## Animales

- Se elimina la categoría «En propiedad / Fuera de propiedad».
- Un animal pertenece a una propiedad y conserva historial de cambios.
- Su ubicación actual sigue la jerarquía `propiedad → grupo → potrero o corral`.
- Producción y reproducción aceptarán hora opcional.
- Las fechas y horas se almacenan con zona horaria; la finca usa por defecto
  `America/Guayaquil`.

## Catálogos

- Las especies son globales y de solo lectura para los usuarios.
- La primera versión admite únicamente bovinos mediante `BOVINE_V1`.
- Una especie nueva se incorpora únicamente después de implementar sus reglas.
- Las unidades de medida son globales y se filtran por contexto de uso.
- Una presentación comercial no se considera unidad de medida.
- Razas y colores son extensibles; los demás catálogos operativos pertenecen a
  la propiedad correspondiente.
- Las reglas se validan tanto online como offline y siempre se confirman en API.

## Límites de cuenta

- Los límites se comparten entre todas las propiedades de una cuenta propietaria.
- El valor inicial es 2 GiB de multimedia, 100 animales gestionados y 10 colaboradores.
- Los colaboradores se cuentan como personas únicas; una invitación pendiente reserva cupo.
- Reducir un límite no elimina datos existentes, pero bloquea nuevas altas.
- El superadministrador puede modificar o retirar cada límite con auditoría.

## Estado y venta de animales

- Los estados de disponibilidad son `ACTIVE`, `MISSING`, `INACTIVE`, `EXITED` y `DEAD`.
- Venta, donación, sacrificio y traslado externo son motivos de salida.
- Una venta exige indicar si el animal permanece, sale o se transfiere.
- Una venta en borrador no cambia el animal; la confirmación aplica todo en una transacción.
- Las reversiones conservan el evento original y exigen motivo y auditoría.

## Multimedia

- La aplicación instalada utiliza módulos nativos para procesar y sincronizar archivos.
- Imágenes y videos se comprimen y limpian antes de subir para ahorrar conexión.
- El servidor vuelve a validar y codificar; nunca confía únicamente en el cliente.
- Se eliminan metadatos EXIF, GPS, dispositivo y nombres originales.
- La cuota cuenta la versión canónica, no las miniaturas generadas internamente.
- La deduplicación se limita a una misma cuenta y las cargas son reanudables e idempotentes.

## Archivo y borrado

- Venta, muerte, desaparición o traslado nunca eliminan físicamente un animal.
- Los animales reales se archivan; la papelera se reserva para errores y duplicados.
- Enviar a papelera cierra ubicación y grupo dentro de la misma transacción.
- La purga se bloquea si existen operaciones históricas dependientes.
- La auditoría conserva instantáneas y no depende de la existencia del animal.
- Un archivo externo solo se marca purgado después de que el proveedor confirme su eliminación.
- Los trabajos de eliminación son idempotentes, reintentables y reconciliables.

## Núcleo ganadero

- Fecha de nacimiento e ingreso son fechas civiles sin conversión de zona horaria.
- Disponibilidad del animal y ciclo del registro son estados independientes.
- Madre y padre se guardan como relaciones validadas, no como columnas libres.
- Un progenitor externo puede conservarse como nombre informado sin crear un animal ficticio.
- Grupo y ubicación se guardan como intervalos históricos; solo uno puede permanecer abierto por animal.
- Restaurar desde papelera no reabre automáticamente una ubicación potencialmente obsoleta.
- La ocupación excluye desaparecidos, salidos, muertos, archivados y registros en papelera.
