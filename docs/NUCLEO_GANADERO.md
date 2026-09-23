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
`POST /animals`. Se limita a la propiedad y rol activos; la búsqueda por nombre,
arete individual o marquilla se pagina de 40 en 40. El alta registra nombre,
sexo y especie bovina obligatorios; arete individual, marquillas elegidas,
nacimiento, ingreso y peso inicial son opcionales.
Si no se indica ingreso, se toma el día civil actual de la zona horaria de la
finca, no el día UTC del servidor. No se admiten fechas futuras ni nacimiento
posterior al ingreso. El servidor valida la unidad de peso, evita aretes individuales
duplicados, respeta el límite compartido por cuenta y audita cada creación.
Raza y colores ya pueden elegirse al crear un animal. Solo se admiten opciones
vigentes de la propiedad y especie; puede haber una raza y varios colores. La
ficha conserva los nombres aunque después se desactiven en el catálogo. La
edición de raza y colores usa la versión del animal y conserva las asignaciones
anteriores como filas cerradas, con auditoría. La migración `0009` crea esa tabla histórica.
La descripción del animal es opcional (hasta 5000 caracteres), se muestra en la
ficha y se edita con control de versión y auditoría.

Las marquillas o fierros son registros independientes de la propiedad, creados en
`POST /animal-brands` con permiso `CATALOG_MANAGE`. `GET /animal-brands` las lista
para su selección; `PATCH /animal-brands/:id` permite activarlas o desactivarlas.
Al registrar un animal se envían sus identificadores en `brandIds`, nunca texto
libre como marquilla. Se pueden elegir varias, incluso para animales distintos;
el arete `earTagCode` sigue siendo el identificador individual. Las asignaciones
se pueden modificar en `PATCH /animals/:id/brands` con la versión del animal:
se conserva el historial y una marquilla desactivada sigue visible en la ficha,
pero no se admite para nuevas asignaciones. La migración `0010` crea estas tablas;
el migrador habitual la aplica, sin pegar SQL manualmente. La carga de imágenes
de fierros se incorporará con el flujo multimedia, todavía no operativo.
Los propietarios se incorporarán en un flujo posterior.

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
La ficha permite elegir un animal de la propiedad o indicar un nombre externo para
cada rol. `PATCH /animals/:id/parents` modifica ambas relaciones con control de
versión, historial de correcciones y auditoría. La búsqueda ofrece los primeros
40 animales coincidentes; conviene acotar por nombre o arete cuando hay más.

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
`GET/POST /groups` crea y consulta grupos de la propiedad; también admite nombre,
descripción y ubicación inicial opcional. `PATCH /groups/:id` edita sus datos;
`PATCH /groups/:id/state` archiva un grupo vacío cerrando su ubicación. Los
potreros y corrales se crean mediante `POST /locations` y se listan con
`GET /locations`, siempre dentro de la propiedad activa.

Los módulos **Potreros**, **Corrales** y **Movimientos** deben estar habilitados
en la cuenta y en la propiedad para asignar un grupo a una ubicación. Cada
potrero o corral solo se crea si su módulo respectivo está habilitado. Al
desactivar módulos, las posiciones e intervalos existentes siguen visibles;
queda impedido asignar nuevas ubicaciones. La migración `0011` agrega los dos
módulos de ubicaciones y prepara las cuentas existentes sin SQL manual.

`POST /groups/:id/animals` asigna un animal al grupo. Si el grupo tiene ubicación,
el animal la hereda; sus intervalos anteriores se cierran en la misma transacción.
`PATCH /groups/:id/location` mueve al grupo completo entre ubicaciones o lo deja
sin ubicación, cambiando también los intervalos de todos sus animales de forma
atómica y con auditoría. Los movimientos más amplios, borradores y sincronización
offline se incorporarán en la fase de operaciones.

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
