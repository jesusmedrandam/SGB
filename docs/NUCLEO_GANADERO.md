# Núcleo ganadero

## Identidad y fechas

Cada animal conserva el mismo identificador durante toda su vida, aunque cambie
de propiedad. El código de arete es único dentro de la propiedad mientras el
registro no haya sido purgado, pero no se utiliza como clave técnica.

La fecha de nacimiento y la fecha de ingreso son valores `date`: la aplicación
no les agrega zona horaria ni los convierte a UTC. Los instantes de movimientos,
estados y auditoría usan `timestamptz`; se guardan como instantes y se muestran
en la zona horaria configurada para la propiedad.

El primer flujo operativo de la API es `GET /animals`, `GET /animals/:id` y
`POST /animals`. Se limita a la propiedad y rol activos; la búsqueda por nombre
o marquilla se pagina de 40 en 40. El alta registra nombre, sexo y especie bovina
obligatorios; marquilla, nacimiento, ingreso y peso inicial son opcionales.
Si no se indica ingreso, se toma el día civil actual de la zona horaria de la
finca, no el día UTC del servidor. No se admiten fechas futuras ni nacimiento
posterior al ingreso. El servidor valida la unidad de peso, evita marquillas
duplicadas, respeta el límite compartido por cuenta y audita cada creación.
La asociación de razas y colores, los progenitores, propietarios y multimedia
se incorporarán en flujos posteriores con sus propias reglas y relaciones.

## Estado frente a ciclo del registro

Son conceptos distintos:

- **Disponibilidad:** activo, desaparecido, inactivo, salió o murió.
- **Ciclo del registro:** actual, archivado, papelera o purgado.

El usuario no modifica estas columnas con un selector genérico. Cada transición
se ejecuta como una operación de dominio, valida la versión leída y genera un
evento y una auditoría. Una salida o muerte cierra grupo y ubicación sin borrar
el historial.

## Parentesco y propiedad

Madre y padre son relaciones independientes. El servidor valida sexo, especie,
orden de fechas y ciclos de parentesco. Cuando el progenitor no está registrado
se permite conservar únicamente un nombre informado, sin crear un animal falso.

Un animal admite varios propietarios. Cada propietario puede ser un usuario,
una persona externa o una organización; las participaciones vigentes no pueden
superar el 100 % y solo existe un propietario principal vigente.

## Grupos y ubicaciones

La ubicación física es un potrero o un corral. Grupo y ubicación se registran
como intervalos con fecha y hora de inicio y fin. Por animal solo puede existir
un intervalo abierto de grupo y uno de ubicación, y los intervalos históricos
cerrados son inmutables.

Una asignación de grupo a ubicación también es temporal. Un grupo solo puede
ocupar una ubicación a la vez y una ubicación solo puede tener un grupo abierto.
Los movimientos de grupo se aplicarán como lotes atómicos e idempotentes.

La vista de ocupación cuenta exclusivamente animales con registro actual y
estado activo o inactivo. Desaparecidos, animales que salieron, muertos,
archivados y registros en papelera no mantienen ocupado un potrero aunque se
detecte un intervalo antiguo inconsistente.

## Papelera

Enviar un animal a papelera es una única transacción:

1. comprueba permiso, versión y clave idempotente;
2. cierra grupo y ubicación;
3. oculta sus relaciones multimedia;
4. envía a papelera los archivos que ya no tengan otra relación activa;
5. conserva una instantánea y la posición anterior;
6. actualiza el ciclo del registro;
7. escribe la auditoría.

La restauración recupera el perfil y la multimedia dentro del plazo permitido.
No reabre automáticamente el grupo ni el potrero anterior: deben elegirse de
nuevo para no ocupar una ubicación que pudo asignarse a otro grupo mientras el
animal estuvo en papelera.

No se permite `DELETE` directo sobre animales, parentescos, propietarios,
grupos, ubicaciones, asignaciones ni eventos de estado.
