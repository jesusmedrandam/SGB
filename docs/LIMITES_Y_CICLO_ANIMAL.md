# Límites de cuenta y ciclo del animal

## Ámbito de los límites

Los límites pertenecen a la **cuenta administrativa** y se comparten entre
todas sus propiedades. Las propiedades donde el propietario solo colabora no
consumen sus límites personales; consumen los de la cuenta propietaria.

| Recurso | Valor inicial | Forma de contabilizar |
| --- | ---: | --- |
| Multimedia | 2 GiB | Archivos originales conservados en todas las propiedades |
| Animales gestionados | 100 | Activos, desaparecidos e inactivos temporalmente |
| Colaboradores | 10 | Personas únicas activas o invitadas, sin contar al propietario |

Una persona asignada a varias propiedades de la misma cuenta ocupa un solo
cupo. Una invitación pendiente reserva el cupo para evitar sobreasignaciones.
Los administradores también cuentan como colaboradores.

El superadministrador puede aumentar, reducir o dejar sin límite cada recurso.
Si reduce un límite por debajo del uso actual no se elimina información: se
bloquean nuevas altas, reactivaciones, invitaciones o cargas hasta volver a
estar dentro del límite. Al 80 % se muestra una advertencia preventiva.

El almacenamiento contabiliza el archivo original finalmente conservado. Las
miniaturas y derivados técnicos generados por el sistema no consumen la cuota
del usuario. Una carga debe reservar espacio antes de iniciarse y confirmarlo
al completarse; una carga fallida libera la reserva.

## Estado del animal

Los estados no serán un catálogo editable:

- `ACTIVE`: participa en operaciones permitidas.
- `MISSING`: está desaparecido, pero sigue bajo gestión y consumiendo cupo.
- `INACTIVE`: pausa administrativa con motivo obligatorio; también consume cupo.
- `EXITED`: dejó la gestión por una salida documentada.
- `DEAD`: estado final producido por un registro de muerte.

Venta, donación, sacrificio y traslado externo son **motivos de salida**, no
estados independientes. La condición sanitaria y el estado productivo se
registran por separado para no mezclar conceptos.

Los cambios de estado se producen mediante eventos de dominio. No se modifica
directamente una columna desde un selector genérico. Corregir una muerte o una
salida exige una operación de reversión, motivo y auditoría; nunca se borra el
evento original.

## Venta de animales

Cada animal incluido en una venta debe declarar uno de estos efectos:

1. **Permanece en la propiedad:** se registra la venta y el animal continúa
   activo en la ubicación actual.
2. **Sale de la propiedad:** al confirmar la venta se cierra su ubicación y
   cambia a `EXITED` con motivo `SALE`.
3. **Se transfiere a otra propiedad:** permanece activo, cambia de propiedad y
   conserva todo su historial. Si pertenece a otra cuenta, la propiedad destino
   debe aceptar la transferencia antes de ejecutarla.

Una venta en borrador no cambia animales. La confirmación actualiza venta,
finanzas, estado, ubicación y auditoría en una sola transacción. La anulación
crea una reversión y solo restaura el estado anterior si no existen operaciones
posteriores incompatibles.
