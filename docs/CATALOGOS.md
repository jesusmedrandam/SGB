# Gobierno de catálogos

Los catálogos no comparten un CRUD genérico. Cada catálogo declara su ámbito,
quién puede modificarlo y las reglas que deben cumplirse en API, base de datos
y modo offline.

## Clasificación

| Tipo | Comportamiento | Ejemplos |
| --- | --- | --- |
| Solo sistema | Se entrega con una versión del servidor. Ningún usuario crea elementos. | Especies, unidades, estados, sexos y vías de administración |
| Extensible por propiedad | Conserva opciones oficiales y permite opciones locales controladas. | Razas y colores |
| Propio de la propiedad | Cada finca administra su lista y ningún registro se comparte accidentalmente. | Medicamentos, compradores, pastos, productos y motivos |

Un permiso de administración de catálogos no permite modificar catálogos de
sistema. Tampoco existirán rutas que conviertan directamente un nombre recibido
por URL en el nombre de una tabla SQL.

## Especies y operaciones

La primera versión admite únicamente `BOVINE`, asociada al conjunto de reglas
`BOVINE_V1`. Agregar un nombre a una lista no habilita una especie nueva.
Primero se implementan y prueban sus reglas; después una migración la incorpora
al catálogo y el superadministrador puede habilitarla para una cuenta.

La disponibilidad de una acción se resuelve con estas cuatro condiciones:

1. módulo habilitado para cuenta y propiedad;
2. especie habilitada para cuenta y propiedad;
3. capacidad implementada para la especie;
4. elegibilidad del animal por sexo, edad, estado productivo y antecedentes.

La misma decisión se ejecuta en servidor y se descarga para validación offline.
La interfaz solo oculta acciones como ayuda: la API siempre vuelve a validarlas.

## Unidades

Las unidades físicas son globales y no se pueden crear desde la interfaz. Cada
campo consulta un contexto de uso. `HECTARE`, por ejemplo, pertenece a
`LAND_AREA` y nunca se devuelve para `MEDICINE_DOSE`.

Las presentaciones comerciales no son unidades. Una propiedad puede registrar
«Saco de 40 kg», «Caja de 12 unidades» o «Caneca de 20 l» como presentación de
un producto, manteniendo por separado su cantidad y unidad física.

Las dosis sugeridas se modelarán de forma estructurada. El numerador puede ser
`mg`, `g`, `ml` o unidades, y el denominador opcional puede ser el peso del
animal. El tratamiento realizado conserva la cantidad realmente aplicada.

## Reglas de implementación

- Todas las listas se filtran en el servidor, no solamente en el selector visual.
- Toda escritura se vuelve a validar aunque haya sido creada offline.
- Los registros propios incluyen `property_id NOT NULL`.
- Desactivar una opción conserva el historial que ya la utiliza.
- Los códigos del sistema son estables; las etiquetas visibles pueden traducirse.
- Una unidad incompatible produce un error de dominio claro y no se guarda.
- El paquete offline incluye definiciones, relaciones permitidas y su versión.

## Primera pantalla de catálogos

La API expone `GET /catalogs/reference` con especies habilitadas y las unidades
compatibles con `ANIMAL_WEIGHT` y `LAND_AREA`. `GET /catalogs/BREEDS/items` y
`GET /catalogs/COLORS/items` combinan opciones oficiales con las de la propiedad
activa. Las opciones de otras propiedades nunca aparecen.

Para razas y colores, `POST /catalogs/:catalogCode/items` crea una opción local
y `PATCH /catalogs/:catalogCode/items/:id` activa o desactiva la propia. Requieren
`CATALOG_MANAGE`; las lecturas requieren `CATALOG_VIEW`. La API comprueba el rol
de nuevo dentro de la transacción y audita los cambios. Desactivar una opción no
la borra ni altera las referencias históricas. Los catálogos de solo sistema y
los propios de la propiedad tendrán sus reglas específicas en entregas posteriores.
