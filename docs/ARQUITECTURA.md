# Arquitectura fundacional

## Límite de datos

La unidad de aislamiento operativo es la **propiedad**. Todas las tablas de
negocio deberán incluir `property_id NOT NULL`, salvo datos globales y privados
del usuario. El servidor nunca aceptará un `property_id` solamente porque lo
envíe el cliente: comprobará una membresía activa y el rol activo en cada petición.

## Jerarquía

```text
Plataforma
└── Cuenta administrativa
    ├── módulos permitidos y límite de propiedades
    └── Propiedades
        ├── propietario
        ├── administradores y colaboradores
        ├── roles y permisos
        └── datos ganaderos
```

Una persona puede ser propietaria de su cuenta y, al mismo tiempo, tener
membresías en propiedades pertenecientes a otras cuentas.

## Contexto activo

El token de sesión identifica a la persona y al dispositivo. La petición lleva
la propiedad y el rol activos. El middleware valida:

1. sesión vigente;
2. membresía activa;
3. rol asignado a esa membresía;
4. módulo habilitado para cuenta y propiedad;
5. permiso requerido por la operación.

El contexto no sustituye las validaciones del servidor. Cambiar de propiedad o
rol no requiere cerrar sesión.

## Offline

Las claves locales usarán el espacio:

```text
usuario / propiedad / rol / recurso
```

La cola de sincronización guardará propiedad, rol, identificador idempotente y
versión del registro. El servidor rechazará duplicados y conflictos; una acción
aplicada dejará de estar disponible localmente incluso antes de sincronizar.

## Módulos iniciales

### Núcleo no desactivable

- Cuenta y perfil
- Propiedades
- Usuarios, invitaciones, membresías, roles y permisos
- Animales, grupos y ubicaciones
- Catálogos básicos
- Auditoría y configuración

### Configurables

- Producción
- Pesajes
- Ingresos y egresos de la propiedad
- Mis finanzas
- Contenido sin conexión
- Reproducción
- Movimientos
- Sanidad
- Limpieza de potreros
- Ventas y compras
- Tareas y eventos
- Multimedia y fichas públicas

`MULTI_PROPERTY` se representa como una capacidad con límite, no como una
segunda clase de propiedad.

«Mis finanzas» es la excepción: se habilita para la persona y sus registros no
incluyen `property_id`. Ni el superadministrador ni los administradores de finca
pueden consultarlos mediante la aplicación.

La vista `effective_property_module` aplica siempre la intersección entre lo
permitido por el superadministrador y lo activado por la propiedad. Si falta
una configuración, el módulo queda deshabilitado por defecto. Los módulos de
usuario se resuelven por separado mediante `effective_user_module`.

## Seguridad

- Contraseñas con hash fuerte y factor de trabajo configurable.
- Tokens de activación y recuperación almacenados únicamente como hash.
- Sesiones revocables por dispositivo.
- Bloqueo progresivo de intentos fallidos.
- Consultas parametrizadas y validación de entrada compartida.
- Auditoría inmutable para acciones privilegiadas.
- PostgreSQL Row Level Security como segunda barrera, después de los permisos API.
- TLS para API, base de datos y almacenamiento multimedia.
- Ningún secreto dentro del repositorio o de la aplicación Android.

## Estrategia de construcción

Se reutilizarán patrones visuales y reglas confirmadas del sistema anterior, no
su esquema de datos. Los módulos se incorporarán verticalmente: migración,
API, permisos, interfaz, offline, auditoría y pruebas antes de iniciar el siguiente.
