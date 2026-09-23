# Política multimedia

## Registros disponibles para adjuntos

Los identificadores de celos, servicios reproductivos, preñeces, partos,
pérdidas, lactancias, ordeños y producción de tanque son estables y tienen
su tipo en `media_entity_type_catalog`. La API de carga debe verificar en
servidor que el registro indicado pertenezca a la misma cuenta y propiedad
del archivo antes de insertar `media_attachment`, y conservar los adjuntos
al cerrar o cancelar registros históricos. La inscripción del tipo no habilita
todavía la carga de archivos: se implementará con la validación y cuotas de
esta política.

## Estrategia híbrida

La aplicación conserva la interfaz compartida en React y se distribuye mediante
una capa nativa. En Android, los módulos nativos administran cámara, compresión,
SQLite, almacenamiento seguro, notificaciones y cargas en segundo plano. No es
necesario mantener dos interfaces independientes para obtener estas capacidades.

El procesamiento ocurre en dos niveles:

1. **Dispositivo:** reduce tamaño antes de consumir datos móviles, corrige la
   orientación, elimina metadatos y deja un archivo preparado en la cola offline.
2. **Servidor:** considera el archivo no confiable, comprueba su contenido real,
   lo vuelve a decodificar y genera la versión canónica y sus miniaturas.

La validación del servidor es obligatoria porque una API también puede recibir
archivos desde clientes antiguos o manipulados.

## Imágenes

- Se aceptan JPEG, PNG, WebP y HEIC como entrada si el dispositivo puede
  decodificarlos.
- Antes de borrar EXIF se aplica la orientación correcta de la cámara.
- La versión de carga usa WebP con calidad inicial 82; JPEG es el respaldo.
- El lado mayor queda limitado a 2560 píxeles.
- El archivo procesado no puede superar 5 MiB.
- El servidor genera miniaturas de 512 píxeles y no conserva el archivo bruto
  recibido de la cámara.
- Se eliminan EXIF, GPS, IPTC, XMP, modelo del teléfono y nombre original.

Las etiquetas, relaciones, descripción y fecha que el usuario decida conservar
son campos propios del sistema; no se recuperan silenciosamente desde EXIF.

## Videos

- La aplicación nativa genera MP4 con H.264 y audio AAC.
- La calidad predeterminada es 720p, adecuada para consulta móvil y offline.
- La duración inicial máxima es 5 minutos y el archivo procesado, 120 MiB.
- Se normaliza la orientación y se eliminan ubicación, dispositivo y metadatos
  del contenedor.
- El proceso puede pausarse por batería baja y reanudarse mediante el trabajo en
  segundo plano del sistema operativo.

Los límites por archivo son independientes de la cuota total de 2 GiB y podrán
ser modificados por el superadministrador sin actualizar la aplicación.

## Seguridad del servidor

El servidor no confía en extensión ni `Content-Type`. Verifica firma binaria,
dimensiones, duración y tamaño; limita memoria de decodificación y rechaza
archivos truncados, polimórficos o incompatibles. La ruta del objeto utiliza un
identificador aleatorio, nunca el nombre proporcionado por el dispositivo.

La versión canónica se vuelve a codificar, por lo que los metadatos no sobreviven
aunque un cliente omita el procesamiento local. Los archivos rechazados no se
publican ni se relacionan con animales.

## Cuota y deduplicación

- La cuota contabiliza únicamente la versión canónica almacenada; miniaturas y
  derivados internos no consumen cuota.
- Un hash SHA-256 permite reutilizar el mismo objeto dentro de una cuenta sin
  cobrarlo varias veces. Nunca se deduplica entre cuentas.
- Antes de subir se reserva temporalmente el tamaño procesado. La confirmación
  consume la reserva y un fallo la libera.
- Los elementos enviados a papelera continúan consumiendo cuota durante 30 días.
  Vaciar la papelera los purga y libera espacio inmediatamente.

## Flujo offline

```text
LOCAL_PENDING → CLIENT_PROCESSING → QUEUED → UPLOADING
              → SERVER_VALIDATING → AVAILABLE
```

La cola conserva identificador idempotente, propiedad, relaciones, checksum,
tamaño, progreso y ruta local. Una carga reintentada no crea duplicados. Si otra
carga agotó la cuota mientras el dispositivo estaba offline, el servidor devuelve
`QUOTA_EXCEEDED`; el archivo permanece local hasta liberar espacio o ampliar el
límite.

El usuario podrá elegir entre sincronizar siempre o cargar videos únicamente con
Wi-Fi. Cerrar la pantalla no cancela una carga ya entregada al gestor nativo.
