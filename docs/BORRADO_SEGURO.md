# Archivo, papelera y borrado seguro

## Regla principal

Un animal real no se elimina para representar venta, muerte, desaparición o
traslado. Esos casos usan eventos y estados del ciclo del animal. La papelera se
reserva para duplicados, pruebas y registros creados por error.

La interfaz distingue tres acciones:

- **Archivar:** conserva el perfil y todo el historial en modo de consulta.
- **Mover a papelera:** oculta un registro erróneo durante el plazo recuperable.
- **Purgar:** proceso posterior y controlado; nunca es un `DELETE` directo desde
  la pantalla del animal.

## Transacción al mover un animal a papelera

La operación bloquea el animal y ejecuta de forma atómica:

1. valida permiso, motivo y versión del registro;
2. cierra el intervalo abierto de ubicación con la misma fecha y hora;
3. cierra la pertenencia abierta al grupo;
4. retira al animal de operaciones y tareas futuras pendientes;
5. revoca sus enlaces públicos;
6. oculta sus relaciones multimedia de las galerías operativas;
7. guarda una instantánea identificable en `entity_tombstone`;
8. registra valores anteriores y posteriores en auditoría;
9. marca el registro para papelera y confirma toda la transacción.

Si cualquiera de estos pasos falla, ninguno se aplica. Por ello no puede quedar
un animal eliminado manteniendo un potrero ocupado.

La ocupación se calcula desde intervalos abiertos de ubicación, no desde la
fecha inicial hasta hoy de forma aislada. Existirá un único intervalo abierto
por animal. Animales en papelera, muertos o que salieron no cuentan como
ocupantes, incluso si se detecta un dato histórico inconsistente.

## Purga de animales

Durante 30 días el propietario puede restaurar el perfil y su multimedia. La
ubicación y el grupo anteriores quedan en el historial, pero no se reabren de
forma automática porque pudieron cambiar mientras el registro estuvo oculto.
Al restaurar se elige nuevamente una posición válida.
Al vencer el plazo:

- un registro sin operaciones dependientes puede purgar sus datos operativos;
- un animal con producción, reproducción, sanidad, ventas u otro historial no
  se destruye en cascada: permanece archivado o se corrige mediante una fusión;
- la auditoría conserva identificador, etiqueta e instantánea y nunca tiene una
  clave foránea que exija que el animal continúe existiendo.

Corregir una relación materna, un duplicado o una venta se realiza mediante una
operación explícita. No se deshabilitan temporalmente disparadores ni claves
foráneas para forzar eliminaciones.

## Archivos externos

La base de datos conserva un `storage_object` por archivo canónico y
`media_attachment` para cada relación. El enlace al proveedor nunca es la única
fuente de verdad.

Al eliminar la última relación:

1. el objeto pasa a papelera y continúa consumiendo cuota;
2. al vencer la retención solo pasa a `DELETE_PENDING` si ya no tiene ninguna
   relación activa;
3. un trabajador reclama el trabajo con bloqueo, solicita el borrado al
   proveedor y reintenta con espera progresiva;
4. solamente una respuesta confirmada marca el trabajo `COMPLETED`;
5. entonces el objeto puede quedar `PURGED` y liberar definitivamente la cuota.

Si Cloudinary u otro proveedor falla, el objeto permanece identificado como
pendiente y visible para administración. Nunca se elimina primero la fila de la
base de datos. Un proceso periódico reconcilia trabajos fallidos, referencias
huérfanas y objetos del proveedor sin correspondencia.

## Multimedia y perfiles archivados

Archivar un animal no rompe sus fotografías. Su perfil histórico continúa
abriendo en modo de consulta y la multimedia muestra la instantánea del animal.
Moverlo a papelera oculta esas imágenes de la galería general, pero permite
restaurarlas conjuntamente. Una imagen compartida con otros animales no se
borra mientras conserve otra relación activa.

Los enlaces públicos utilizan identificadores del sistema y se revocan al
archivar o enviar a papelera; nunca exponen directamente el identificador del
proveedor de almacenamiento.
