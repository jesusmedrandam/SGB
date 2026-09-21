# Decisiones confirmadas

Fecha de corte: 2026-09-21.

## Identidad y administración

1. Existe un único rol de plataforma `SUPERADMIN`.
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
