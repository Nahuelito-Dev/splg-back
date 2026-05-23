# Documento de Requisitos del Sistema
**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas
**Versión:** 1.2
**Fecha:** 2026-05-03
**Realizado por:** Nahuel Wagner
**Realizado para:** Distribuidor de Gas Envasado (Cliente Real)
**Institución:** FCEQyN – UNaM
**Metodología:** Unified Process (UP)

---

## Leyenda de Prioridad

| Indicador | Prioridad | Significado |
|:---------:|-----------|-------------|
| 🔴 | **Crítico** | El sistema no puede funcionar sin este elemento. Debe implementarse en las primeras iteraciones. |
| 🟡 | **Importante** | Agrega valor significativo al sistema. Forma parte del MVP pero no bloquea la operación base. |
| ⚪ | **Secundario** | Deseable pero prescindible en Fase 1. Puede diferirse a iteraciones posteriores. |
| 🤖 | **Automático** | Proceso ejecutado por el sistema sin intervención humana. |

---

## Lista de Cambios

| Nro | Fecha | Descripción | Autor |
|-----|-------|-------------|-------|
| 0 | 2026-04-17 | Versión inicial | Nahuel Wagner |
| 1 | 2026-05-03 | Nombre corregido a SPLG. IRQ-08 agregado. CU expandidos: CU-003, CU-006, CU-007, CU-008, CU-009, CU-010, CU-011. NFR-07 y NFR-08 agregados. Matriz de rastreabilidad completa. Glosario ampliado. | Nahuel Wagner |

---

## 1. Presentación General

El proyecto SPLG surge de la necesidad de digitalizar la operación de un distribuidor de gas envasado que actualmente gestiona todos sus procesos de forma analógica: los clientes realizan pedidos por teléfono, los choferes reciben instrucciones verbales y el stock se registra manualmente en planillas. Esta situación genera demoras en la atención, errores en los pedidos, imposibilidad de rastrear entregas y reclamos sin evidencia objetiva.

El sistema propuesto integra cuatro componentes: una **App Cliente** (Flutter) para realizar pedidos y hacer seguimiento en tiempo real, una **App Chofer** (Flutter) para gestionar las entregas con GPS, un **Panel Administrativo** (React/Vite) para la gestión operativa completa, y un **Backend API** (NestJS) que centraliza toda la lógica de negocio, la base de datos PostgreSQL, el cache Redis y las notificaciones Firebase.

### Participantes del Proyecto

| Rol | Nombre |
|-----|--------|
| Desarrollador / Analista | Nahuel Wagner |
| Cliente / Usuario Final | Distribuidor de Gas Envasado |
| Docente Supervisor | Lic. Sergio Daniel Caballero |
| Institución | FCEQyN – UNaM |

---

## 2. Objetivos del Sistema

| Código | Prioridad | Objetivo | Descripción | Estabilidad |
|--------|:---------:|----------|-------------|:-----------:|
| OBJ-01 | 🔴 | Digitalizar la gestión de pedidos | Reemplazar el flujo telefónico por una plataforma digital donde el cliente realice pedidos de forma autónoma desde la app móvil, sin intervención del operador para registrar el pedido. | Alta |
| OBJ-02 | 🔴 🤖 | Automatizar el despacho por proximidad | Asignar automáticamente el chofer disponible más cercano al domicilio de entrega sin intervención manual del operador, usando geolocalización en tiempo real (Redis GEORADIUS). | Alta |
| OBJ-03 | 🔴 | Proveer seguimiento en tiempo real | Permitir al cliente ver la ubicación del chofer en un mapa mientras su pedido está en camino, mediante comunicación WebSocket bidireccional. | Alta |
| OBJ-04 | 🟡 | Garantizar trazabilidad de entregas | Registrar evidencia objetiva (foto opcional, timestamps de cada cambio de estado, GPS) de cada entrega para resolver reclamos de forma objetiva y sin disputa. | Alta |
| OBJ-05 | 🟡 | Centralizar el control operativo | Brindar al administrador una herramienta única (Panel Web) para gestionar choferes, vehículos, productos, stock, precios, franjas horarias, reclamos y visualizar reportes en tiempo real. | Alta |
| OBJ-06 | 🔴 🤖 | Sincronizar el inventario en tiempo real | Reservar automáticamente el stock al confirmar un pedido (transacción atómica PostgreSQL) y restituirlo automáticamente si el pedido se cancela, evitando ventas sin producto disponible. | Alta |
| OBJ-07 | 🟡 | Habilitar múltiples métodos de pago | Permitir al cliente pagar con efectivo, MercadoPago o transferencia bancaria, con aplicación automática del recargo del 10% para transferencias. | Alta |
| OBJ-08 | 🟡 | Gestionar franjas horarias de entrega | Permitir al administrador configurar rangos horarios de entrega con capacidad máxima diaria para distribuir la carga de trabajo de los choferes de forma ordenada. | Media |

---

## 3. Diagrama de Casos de Uso del Sistema

> **[ INSERTAR IMAGEN: diagrama-cu-sistema.png ]**
> *(Ver guía de construcción en Doc 0 — Sección 9)*

---

## 4. Subsistemas del Proyecto

> **[ INSERTAR IMAGEN: diagrama-subsistemas.png ]**

| Código | Subsistema | Descripción |
|--------|------------|-------------|
| SS-01 | Autenticación y Usuarios | Registro, login y control de acceso diferenciado por rol (Cliente, Chofer, Administrador) usando Firebase Auth + JWT. |
| SS-02 | Gestión de Pedidos | Creación transaccional, ciclo de vida de estados y cancelación de pedidos con reserva y restitución de stock. |
| SS-03 | Despacho y Asignación | Algoritmo automático de búsqueda y notificación del chofer más cercano al pedido, con cron de reintentos con radio expandido. |
| SS-04 | Seguimiento en Tiempo Real | Actualización GPS del chofer y notificaciones de estado al cliente por WebSocket (Socket.IO) y FCM push. |
| SS-05 | Reclamos | Registro de reclamos post-entrega por el cliente, gestión y resolución por el administrador. |
| SS-06 | Reportes y Dashboard | Estadísticas operativas en tiempo real y análisis de ventas para el administrador. |
| SS-07 | Gestión de Choferes y Vehículos | Alta, validación, activación y administración de los repartidores y sus vehículos. |
| SS-08 | Gestión de Productos e Inventario | Catálogo de garrafas, precios, stock actual y promociones por volumen. |
| SS-09 | Franjas Horarias | Configuración de rangos horarios de entrega con capacidad máxima diaria configurable. |

---

## 5. Requisitos de Información

### IRQ-01 — Información sobre Usuarios

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-05 |
| **Requisitos asociados** | CU-001, CU-002, CU-003, CU-004 |
| **Descripción** | El sistema debe almacenar y gestionar la información de los tres tipos de usuario del sistema. |
| **Datos específicos** | Nombre completo, email (único), número de teléfono, rol (CLIENTE / CHOFER / ADMIN), fecha de registro, estado activo/inactivo, token de notificación FCM (para clientes), estado de validación (para choferes: `validated`). |
| **Estabilidad** | Alta |

### IRQ-02 — Información sobre Pedidos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-02, OBJ-06 |
| **Requisitos asociados** | CU-005, CU-006, CU-007, CU-008, CU-009, CU-010 |
| **Descripción** | El sistema debe almacenar el historial completo de cada pedido desde su creación hasta la entrega o cancelación, incluyendo todos los cambios de estado y sus timestamps. |
| **Datos específicos** | ID de pedido (UUID), referencia al cliente, referencia al chofer asignado (nullable), coordenadas de entrega (lat/lng), ítems y cantidades, precio unitario al momento de compra, subtotal por ítem, descuento aplicado (%), total del pedido, método de pago (CASH / MERCADOPAGO / TRANSFER), estado del pago (PENDING / PAID / FAILED), estado del pedido (PENDING / ACCEPTED / ON_THE_WAY / DELIVERED / CANCELLED), franja horaria seleccionada, fecha solicitada de entrega, ventana de entrega (inicio y fin), `dispatchAttempts`, motivo de cancelación (si aplica), timestamps: `createdAt`, `acceptedAt`, `onTheWayAt`, `deliveredAt`. |
| **Estabilidad** | Alta |

### IRQ-03 — Información sobre Choferes y Vehículos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | CU-031, CU-032, CU-033, CU-034, CU-035 |
| **Descripción** | El sistema debe registrar los datos del repartidor, su estado operativo y el vehículo asociado. |
| **Datos específicos** | Datos del usuario (ver IRQ-01). Del perfil Delivery: calificación promedio, balance acumulado, estado de validación (`validated`), estado activo (`isActive`), ubicación GPS actual (almacenada en Redis, no en BD relacional). Del vehículo: tipo (auto / moto / camioneta), patente, marca, modelo, año, color, capacidad de carga. |
| **Estabilidad** | Alta |

### IRQ-04 — Información sobre Productos (Garrafas)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-06, OBJ-07 |
| **Requisitos asociados** | CU-036, CU-037, CU-038, CU-039, CU-040, CU-041 |
| **Descripción** | El sistema debe almacenar el catálogo de garrafas disponibles con su precio vigente y stock actual. |
| **Datos específicos** | Tipo de garrafa (ej: "10kg", "15kg", "45kg"), peso, precio de venta vigente, stock disponible, descripción opcional, estado activo/inactivo, promociones por volumen (almacenadas como JSONB: array de `{ quantity: number, discountPercentage: number }`). |
| **Estabilidad** | Alta |

### IRQ-05 — Información sobre Franjas Horarias

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-08 |
| **Requisitos asociados** | CU-042, CU-043, CU-044, CU-045 |
| **Descripción** | El sistema debe almacenar las franjas horarias de entrega configuradas por el administrador y controlar su capacidad. |
| **Datos específicos** | Nombre de la franja (ej: "Mañana", "Tarde"), hora de inicio (HH:MM), hora de fin (HH:MM), capacidad máxima diaria de pedidos, estado activo/inactivo. |
| **Estabilidad** | Alta |

### IRQ-06 — Información sobre Reclamos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-04, OBJ-05 |
| **Requisitos asociados** | CU-023, CU-024, CU-025 |
| **Descripción** | El sistema debe registrar los reclamos realizados por clientes sobre pedidos entregados, incluyendo la evidencia adjunta y la resolución del administrador. |
| **Datos específicos** | ID de reclamo (UUID), referencia al pedido asociado, referencia al cliente reclamante, motivo del reclamo (texto libre), descripción detallada, URL de foto de evidencia (opcional), estado (PENDING / IN_PROCESS / RESOLVED / REJECTED), nota de resolución del administrador (obligatoria al resolver/rechazar), fecha de creación. |
| **Estabilidad** | Alta |

### IRQ-07 — Información sobre Direcciones de Entrega

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-02 |
| **Requisitos asociados** | CU-005 |
| **Descripción** | El sistema debe almacenar las direcciones de entrega del cliente para agilizar la creación de futuros pedidos. |
| **Datos específicos** | Referencia al cliente propietario, calle y número, referencia adicional (ej: "departamento 3B, timbre roto"), latitud, longitud, alias de la dirección (ej: "Casa", "Trabajo"). |
| **Estabilidad** | Alta |

### IRQ-08 — Información sobre Pagos y Transacciones

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-07 |
| **Requisitos asociados** | CU-005, CU-029 |
| **Descripción** | El sistema debe registrar la información del pago asociado a cada pedido, incluyendo el método, el estado y la referencia externa de MercadoPago cuando corresponda. |
| **Datos específicos** | Método de pago (CASH / MERCADOPAGO / TRANSFER), estado del pago (PENDING / PAID / FAILED), recargo aplicado (porcentaje y monto), ID de preferencia de MercadoPago (para pagos digitales), timestamp de confirmación de pago. |
| **Estabilidad** | Alta |

---

## 6. Requisitos Funcionales — Casos de Uso

### 6.1 Definición de Actores

| Código | Actor | Tipo | Descripción |
|--------|-------|:----:|-------------|
| ACT-01 | Cliente | Humano | Usuario final que realiza pedidos de garrafas mediante la App Cliente (Flutter). |
| ACT-02 | Chofer | Humano | Repartidor que gestiona entregas mediante la App Chofer (Flutter). |
| ACT-03 | Administrador | Humano | Operador del distribuidor que accede al Panel Web (React/Vite). |
| ACT-04 | Sistema | Automático | Proceso interno del backend: cron de despacho, algoritmo GEORADIUS, reserva de stock, notificaciones. |

---

### 6.2 Casos de Uso Expandidos — Críticos

> Los CU Críticos se documentan con formato expandido completo (precondición, secuencia normal, postcondición, excepciones).

---

#### 🔴 CU-001 — Iniciar Sesión

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-01 |
| **Descripción** | El usuario ingresa sus credenciales en la app correspondiente. El sistema verifica la identidad contra Firebase Auth, genera un JWT con el rol del usuario y lo retorna para acceder a las funcionalidades habilitadas. |
| **Precondición** | El usuario está registrado en el sistema y tiene conexión a internet. Si es chofer, debe estar validado por el administrador. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El usuario abre la app (Cliente, Chofer o Panel Web) e ingresa email y contraseña. |
| 2 | El sistema envía las credenciales a Firebase Auth para verificación. |
| 3 | Firebase confirma la identidad y retorna un token de acceso de Firebase. |
| 4 | El sistema valida el token de Firebase, consulta el rol del usuario en la base de datos y genera un JWT propio con `userId`, `email` y `role` en el payload. |
| 5 | El sistema retorna el JWT al cliente. La sesión del Panel Web además configura una cookie `httpOnly`. |
| 6 | El usuario accede a las funcionalidades habilitadas para su rol. |

**Postcondición:** El usuario está autenticado y dispone de un JWT válido para operar el sistema con las funcionalidades de su rol.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si las credenciales son incorrectas, Firebase retorna error de autenticación. El sistema informa "Email o contraseña incorrectos" y el caso de uso termina sin efecto. |
| 3 | Si el usuario Chofer tiene `validated = false`, el sistema informa "Tu cuenta aún no fue habilitada por el administrador" y deniega el acceso. |
| 4 | Si el token de Firebase expiró o fue revocado, el sistema solicita nuevo login. |
| — | Si hay error de red, el sistema informa "Sin conexión a internet. Verificá tu conexión e intentá de nuevo." |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | El login debe completarse en menos de 3 segundos en condiciones normales de red. |
| **Frecuencia** | Múltiples veces por día por usuario. Varía según duración de la sesión. |
| **Estabilidad** | Alta |

---

#### 🔴 CU-002 — Registrarse como Cliente

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01 |
| **Requisitos asociados** | IRQ-01 |
| **Descripción** | Un nuevo usuario se registra como Cliente desde la App Cliente, ingresando sus datos personales. El sistema crea la cuenta y lo autentica automáticamente. |
| **Precondición** | El usuario no tiene cuenta previa con el mismo email. Tiene conexión a internet. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El usuario abre la App Cliente y selecciona "Registrarse". |
| 2 | Ingresa nombre completo, email, número de teléfono y contraseña (mínimo 6 caracteres). |
| 3 | El sistema valida el formato de los campos (email válido, teléfono con formato correcto). |
| 4 | El sistema crea el usuario en Firebase Auth con email y contraseña. |
| 5 | El sistema registra el usuario en la base de datos con rol `CLIENTE` y crea el perfil `Customer` asociado. |
| 6 | El sistema genera un JWT y retorna el token. El usuario queda autenticado automáticamente. |

**Postcondición:** Existe un nuevo usuario con rol CLIENTE en el sistema, con perfil Customer creado, listo para realizar pedidos.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si algún campo requerido está vacío o el formato es inválido, el sistema informa el error específico por campo. |
| 4 | Si el email ya está registrado en Firebase, el sistema informa "El email ya está en uso. ¿Ya tenés cuenta? Iniciá sesión." |
| 5 | Si hay error al persistir en la base de datos, el sistema elimina el usuario creado en Firebase (rollback) e informa error. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-003 — Registrar Chofer

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-01, IRQ-03 |
| **Descripción** | El administrador crea un nuevo usuario chofer desde el Panel Web, ingresando sus datos personales. El chofer queda en estado no validado y no puede operar hasta la aprobación explícita. |
| **Precondición** | El administrador está autenticado en el Panel Web. No existe otro chofer con el mismo email. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → sección "Choferes" → botón "Nuevo Chofer". |
| 2 | Ingresa nombre completo, email, número de teléfono y contraseña temporal. |
| 3 | El sistema valida los campos. |
| 4 | El sistema crea el usuario en Firebase Auth. |
| 5 | El sistema registra el usuario en la base de datos con rol `CHOFER`, crea el perfil `Delivery` con `validated = false` e `isActive = false`. |
| 6 | El sistema retorna confirmación al administrador. |

**Postcondición:** Existe un nuevo usuario con rol CHOFER con perfil Delivery creado, en estado no validado. El chofer no puede aceptar pedidos hasta CU-032.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si algún campo requerido falta, el sistema informa el error. |
| 4 | Si el email ya está registrado, el sistema informa "El email ya está en uso." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-005 — Crear Pedido

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-02, OBJ-06, OBJ-07 |
| **Requisitos asociados** | IRQ-02, IRQ-04, IRQ-05, IRQ-07, IRQ-08 |
| **Descripción** | El cliente selecciona productos, cantidad, dirección de entrega y franja horaria. El sistema verifica el stock, reserva las unidades de forma atómica, calcula el total con promociones y recargos, registra el pedido y dispara el despacho automático. |
| **Precondición** | El cliente está autenticado. Existe al menos un producto activo con stock disponible. El cliente tiene al menos una dirección de entrega registrada. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cliente abre la App Cliente y accede al catálogo de productos (MarketView). |
| 2 | Selecciona uno o más productos e indica la cantidad de cada uno. El sistema muestra el subtotal con descuentos por volumen aplicados en tiempo real. |
| 3 | Accede al CheckoutView y selecciona la dirección de entrega desde la lista guardada o ubicándola en el mapa. |
| 4 | Selecciona la fecha de entrega y una franja horaria disponible para esa fecha. |
| 5 | Selecciona el método de pago: EFECTIVO, MERCADOPAGO o TRANSFERENCIA. Si elige TRANSFERENCIA, el sistema muestra el recargo del 10%. |
| 6 | Revisa el resumen (ítems, descuentos, subtotal, recargo si aplica, total) y presiona "Confirmar Pedido". |
| 7 | El sistema inicia una transacción PostgreSQL (QueryRunner): verifica el stock de cada ítem con lock pesimista (`SELECT FOR UPDATE`), aplica descuentos por volumen, aplica recargo si TRANSFER, decrementa el stock de cada producto. |
| 8 | El sistema persiste el pedido con estado `PENDING` y sus ítems. |
| 9 | El sistema hace commit de la transacción. |
| 10 | El sistema dispara el algoritmo de despacho automático (CU-013). |
| 11 | El sistema envía una notificación FCM push al cliente confirmando la creación del pedido. |
| 12 | La app navega a OrderTrackingView. |

**Postcondición:** Existe un pedido con estado PENDING. El stock fue decrementado atómicamente. Los choferes cercanos fueron notificados por WebSocket.

**Excepciones**

| Paso | Acción |
|------|--------|
| 7 | Si el stock de cualquier ítem es insuficiente, el sistema hace rollback completo e informa "Stock insuficiente para [tipo de garrafa]". El pedido no se crea y el stock no se altera. |
| 7 | Si ocurre un error inesperado durante la transacción, se hace rollback completo e informa error genérico al cliente. |
| 10 | Si no hay choferes en el radio de 5 km, el sistema notifica al cliente "Buscando repartidor disponible..." y el cron reintentará (CU-014). |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | La creación del pedido debe completarse en menos de 5 segundos. |
| **Frecuencia** | Variable según demanda del distribuidor (estimado: 10–50 pedidos/día en Fase 1). |
| **Estabilidad** | Alta |
| **Comentarios** | La precisión del cálculo de totales se garantiza con `decimal.js`. Las promociones por volumen se aplican automáticamente según la cantidad mínima configurada en el producto. |

---

#### 🔴 CU-006 — Consultar Detalle de Pedido

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-03, OBJ-04 |
| **Requisitos asociados** | IRQ-02, IRQ-03 |
| **Descripción** | El usuario accede al detalle completo de un pedido específico. Cada rol visualiza la misma información pero con acciones disponibles diferentes. |
| **Precondición** | El usuario está autenticado. El pedido existe. Si es Cliente, el pedido debe pertenecer al cliente autenticado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El usuario selecciona un pedido desde su listado (historial o panel admin). |
| 2 | El sistema consulta el pedido con todos sus datos: ítems, precios, descuentos, total, estado, chofer asignado (si hay), dirección de entrega, franja horaria, método de pago, timestamps de cada transición de estado. |
| 3 | El sistema retorna la vista detallada del pedido. |
| 4 | El sistema muestra las acciones disponibles según el rol: el cliente puede cancelar (si PENDING/ACCEPTED); el administrador puede cancelar o asignar chofer manualmente. |

**Postcondición:** El usuario visualizó el detalle completo del pedido.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si el cliente intenta ver un pedido que no le pertenece, el sistema retorna error 403 "No autorizado". |
| 2 | Si el pedido no existe, el sistema retorna error 404. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-013 — Asignar Pedido Automáticamente por Proximidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02 |
| **Requisitos asociados** | IRQ-02, IRQ-03 |
| **Descripción** | Inmediatamente después de crearse un pedido, el sistema consulta en Redis los choferes activos dentro de un radio de 5 km del domicilio de entrega y les envía una notificación WebSocket con los datos del pedido. |
| **Precondición** | Existe un pedido con estado PENDING. Al menos un chofer está conectado al WebSocket con su ubicación GPS registrada en Redis (`drivers:available`). |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El sistema recibe el evento de nuevo pedido creado (disparado al finalizar CU-005, post-commit). |
| 2 | Extrae las coordenadas (lat/lng) de la dirección de entrega del pedido. |
| 3 | Consulta Redis con `GEORADIUS drivers:available <lng> <lat> 5 km ASC WITHDIST` para obtener la lista de choferes activos dentro del radio, ordenados por distancia ascendente. |
| 4 | Para cada chofer encontrado, verifica en la base de datos que `isActive = true` y `validated = true`. |
| 5 | Para cada chofer elegible, emite el evento `server:new-order-request` por WebSocket (sala del driverId) con los datos del pedido (ID, total, dirección, ítems, método de pago). |

**Postcondición:** Los choferes cercanos elegibles fueron notificados. El pedido permanece en estado PENDING hasta que alguno lo acepte.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si no hay choferes registrados en Redis dentro del radio de 5 km, el sistema no envía notificaciones. El cron de reintentos (CU-014) reintentará en ~1 minuto. |
| 5 | Si el socket del chofer no está conectado actualmente, la notificación se descarta (el cron reintentará). |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | La consulta a Redis debe completarse en menos de 500ms. |
| **Estabilidad** | Alta |
| **Comentarios** | Solo los choferes con `isActive = true` y `validated = true` son elegibles. La ubicación en Redis se almacena con `GEOADD` y se consulta con `GEORADIUS ASC`. El proceso es completamente asíncrono. |

---

#### 🔴 🤖 CU-014 — Reintentar Asignación con Radio Expandido (Cron)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02 |
| **Requisitos asociados** | IRQ-02, IRQ-03 |
| **Descripción** | Un proceso automático que se ejecuta cada 1 minuto busca pedidos en estado PENDING sin chofer asignado y con más de 2 minutos de antigüedad. Reintenta la búsqueda con radio expandido progresivo. |
| **Precondición** | Existe al menos un pedido con estado PENDING, sin `delivery_id` y con `createdAt < now - 2 minutos`. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cron se ejecuta automáticamente cada 1 minuto (`@Cron('* * * * *')`). |
| 2 | Consulta los pedidos con `status = PENDING` y sin `delivery_id`. |
| 3 | Filtra los pedidos con `createdAt < now - 2 minutos` (para no solaparse con CU-013). |
| 4 | Para cada pedido elegible, determina el radio según `dispatchAttempts`: 0–2 → 5 km; 3–4 → 10 km; 5–7 → 15 km; >8 → estado SIN_COBERTURA. |
| 5 | Consulta Redis con `GEORADIUS` usando el radio calculado. |
| 6 | Si hay choferes: emite `NEW_ORDER_RETRY` por WebSocket a cada chofer encontrado. |
| 7 | Incrementa `Order.dispatchAttempts` y persiste. |
| 8 | Si `dispatchAttempts > 8`: cambia estado a SIN_COBERTURA y notifica al administrador por FCM. |

**Postcondición:** Los choferes en el radio calculado fueron notificados. El campo `dispatchAttempts` fue incrementado.

| Campo | Detalle |
|-------|---------|
| **Frecuencia** | Automático — cada 1 minuto. |
| **Estabilidad** | Alta |

---

#### 🔴 CU-015 — Aceptar Pedido

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-03 |
| **Requisitos asociados** | IRQ-02, IRQ-03 |
| **Descripción** | El chofer recibe la notificación de un nuevo pedido y decide aceptarlo. El sistema lo asigna al pedido y notifica al cliente. |
| **Precondición** | El chofer está autenticado y conectado al WebSocket. El pedido está en estado PENDING. El chofer tiene `isActive = true` y `validated = true`. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer recibe la notificación `server:new-order-request` en su app y presiona "Aceptar". |
| 2 | La app envía la solicitud `PATCH /orders/:id/status` con `{ status: "ACCEPTED" }` al backend. |
| 3 | El sistema verifica que el pedido sigue en estado PENDING. |
| 4 | El sistema verifica que el chofer está activo y validado. |
| 5 | El sistema asigna el `delivery_id` al pedido, cambia el estado a `ACCEPTED` y registra `acceptedAt`. |
| 6 | El sistema emite el evento `order:accepted` al cliente por WebSocket con datos del chofer (nombre, teléfono). |
| 7 | El sistema envía una notificación FCM push al cliente: "¡Tu pedido fue aceptado por [nombre del chofer]!" |

**Postcondición:** El pedido tiene estado ACCEPTED con el chofer asignado. El cliente fue notificado por WebSocket y por FCM.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el pedido ya tiene estado distinto de PENDING (fue aceptado por otro chofer), el sistema retorna error 400 "El pedido ya no está disponible." |
| 4 | Si el chofer tiene `isActive = false` o `validated = false`, el sistema retorna error 400. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 🤖 CU-017 — Actualizar Ubicación GPS del Chofer

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-03 |
| **Requisitos asociados** | IRQ-03 |
| **Descripción** | Mientras el chofer está en línea, la App Chofer envía periódicamente su posición GPS al servidor por WebSocket. El sistema actualiza la ubicación en Redis para el radar de asignación y el mapa del cliente. |
| **Precondición** | El chofer está autenticado y conectado al WebSocket namespace `/drivers`. El dispositivo tiene GPS activo y permisos de ubicación concedidos. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El `LocationService` de la App Chofer detecta un desplazamiento de al menos 10 metros y emite una nueva posición. |
| 2 | El `HomeViewModel` recibe la posición y emite el evento `driver:update-location` por WebSocket con `{ userId, lat, lng }`. |
| 3 | El `DriversGateway` del backend recibe el evento. |
| 4 | Llama a `RedisService.geoAdd('drivers:available', lng, lat, driverId)`. |
| 5 | Si el chofer tiene un pedido activo en estado ON_THE_WAY, el sistema emite `driver:location` al cliente por el `CustomersGateway` para actualizar el mapa. |

**Postcondición:** La ubicación del chofer en Redis está actualizada. El algoritmo de asignación puede encontrarlo. El cliente (si tiene pedido activo) ve la posición actualizada en su mapa.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si lat o lng son inválidos (nulos o fuera de rango), el servidor registra el error y descarta el evento silenciosamente. |
| 2 | Si la conexión WebSocket se interrumpe, Socket.IO intenta reconectarse automáticamente. |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | La actualización en Redis debe completarse en menos de 100ms. |
| **Frecuencia** | Cada vez que el GPS detecta desplazamiento >= 10 metros mientras el chofer está activo. |
| **Estabilidad** | Alta |
| **Comentarios** | La ubicación se almacena solo en Redis (no en BD relacional) para maximizar velocidad. |

---

#### 🔴 CU-018 — Marcar Pedido "En Camino"

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-03 |
| **Requisitos asociados** | IRQ-02 |
| **Descripción** | El chofer indica que salió hacia el domicilio del cliente. El sistema actualiza el estado del pedido y notifica al cliente por WebSocket y FCM. |
| **Precondición** | El pedido tiene estado ACCEPTED. El chofer autenticado es el asignado al pedido. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer presiona "En camino" en su app. |
| 2 | La app envía `PATCH /orders/:id/status` con `{ status: "ON_THE_WAY" }`. |
| 3 | El backend actualiza el estado del pedido a `ON_THE_WAY` y registra `onTheWayAt`. |
| 4 | Emite el evento `order:on-the-way` al cliente por WebSocket (`CustomersGateway`). |
| 5 | Envía notificación FCM push al cliente: "¡Tu pedido está en camino!" |

**Postcondición:** El pedido tiene estado ON_THE_WAY. El cliente recibe la notificación inmediata.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si el pedido no está en estado ACCEPTED, el sistema retorna error 400 "Transición de estado no permitida." |
| 2 | Si el chofer no es el asignado al pedido, el sistema retorna error 403. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-020 — Confirmar Entrega

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-03, OBJ-04 |
| **Requisitos asociados** | IRQ-02, IRQ-08 |
| **Descripción** | El chofer entrega el producto y marca el pedido como entregado. El sistema cierra el ciclo del pedido y notifica al cliente. |
| **Precondición** | El pedido tiene estado ON_THE_WAY. El chofer autenticado es el asignado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer presiona "Confirmar entrega" en su app. |
| 2 | La app envía `PATCH /orders/:id/status` con `{ status: "DELIVERED" }`. |
| 3 | El backend actualiza el estado del pedido a `DELIVERED` y registra `deliveredAt = now()`. |
| 4 | Si el método de pago es CASH, actualiza `paymentStatus = PAID` automáticamente. |
| 5 | Emite el evento `order:delivered` al cliente por WebSocket. |
| 6 | Envía notificación FCM push al cliente: "¡Pedido entregado! Gracias por tu compra." |

**Postcondición:** El pedido tiene estado DELIVERED. El ciclo de entrega está cerrado. Si el pago es efectivo, queda marcado como PAID.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si el pedido ya tiene estado DELIVERED o CANCELLED, el sistema retorna error 400 "El pedido ya está finalizado." |
| 2 | Si el chofer no es el asignado, el sistema retorna error 403. |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | La confirmación debe procesarse en menos de 3 segundos. |
| **Estabilidad** | Alta |

---

#### 🔴 CU-022 — Activar / Desactivar Disponibilidad (Chofer)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02 |
| **Requisitos asociados** | IRQ-03 |
| **Descripción** | El chofer indica si está disponible para recibir pedidos. Al desactivarse, su ubicación se elimina del radar de Redis. |
| **Precondición** | El chofer está autenticado y validado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer activa o desactiva su disponibilidad mediante el toggle en la HomeView de la App Chofer. |
| 2 | La app envía `PATCH /delivery/toggle-availability`. |
| 3 | El backend busca el perfil Delivery del chofer por `user_id`. |
| 4 | Actualiza el campo `isActive` al valor opuesto. |
| 5 | Si `isActive` pasa a `false`: ejecuta `RedisService.zRem('drivers:available', deliveryId)` para eliminarlo del radar. |
| 6 | Si `isActive` pasa a `true` y tiene posición GPS disponible: ejecuta `GEOADD` para registrarlo en el radar. |

**Postcondición:** El estado de disponibilidad del chofer fue actualizado. Si es inactivo, ya no recibirá nuevas asignaciones de pedidos.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-021 — Recibir Notificaciones en Tiempo Real

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-03 |
| **Requisitos asociados** | IRQ-02 |
| **Descripción** | El cliente recibe automáticamente notificaciones de cada cambio de estado de su pedido activo. Si la app está en primer plano, llegan por WebSocket; si está en segundo plano o cerrada, llegan por FCM push notification. |
| **Precondición** | El cliente está autenticado. Existe un pedido activo asociado al cliente. El dispositivo tiene permisos de notificación concedidos. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | Ocurre un evento en el pedido activo del cliente: creación confirmada, chofer asignado, pedido en camino, chofer llegó, entrega confirmada. |
| 2 | El backend emite el evento correspondiente al `CustomersGateway` WebSocket con el `customerId` como destinatario. |
| 3 | Si la App Cliente está en primer plano y conectada al WebSocket: recibe el evento en tiempo real y actualiza la UI del `OrderTrackingView` sin recargar la pantalla. |
| 4 | Si la App Cliente está cerrada o en segundo plano: el sistema envía una notificación FCM push al `notification_token` del cliente con el mensaje del evento. |
| 5 | El cliente lee la notificación y puede tocarla para acceder directamente a la pantalla de seguimiento del pedido. |

**Postcondición:** El cliente está informado del estado actual de su pedido. La UI refleja el último estado recibido.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si la conexión WebSocket se interrumpe, Socket.IO reintenta la reconexión automáticamente con backoff exponencial. |
| 4 | Si el `notification_token` del cliente es inválido o expiró, el envío FCM falla silenciosamente. El cliente puede reiniciar la app para regenerar el token. |
| — | Si el cliente no concedió permisos de notificación, las push no se entregan. El canal WebSocket (app abierta) sigue funcionando. |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | El evento WebSocket debe llegar al cliente en menos de 500ms desde que ocurre el cambio de estado. |
| **Frecuencia** | Por cada cambio de estado del pedido activo (estimado 4–5 eventos por pedido). |
| **Estabilidad** | Alta |

---

#### 🔴 CU-031 — Registrar Chofer

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05 |
| **Requisitos asociados** | IRQ-01, IRQ-03 |
| **Descripción** | El administrador crea un nuevo usuario chofer desde el Panel Web ingresando sus datos personales. El chofer queda registrado en estado no validado y no puede operar hasta que el administrador ejecute la validación explícita (CU-032). |
| **Precondición** | El administrador está autenticado en el Panel Web. No existe otro usuario con el mismo email. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → sección "Choferes" → botón "Nuevo Chofer". |
| 2 | Completa el formulario: nombre completo, email, número de teléfono y contraseña temporal. |
| 3 | El sistema valida que todos los campos requeridos están presentes y con formato correcto (email válido, contraseña mínimo 6 caracteres). |
| 4 | El sistema crea el usuario en Firebase Auth con email y contraseña. |
| 5 | El sistema registra el usuario en la base de datos con rol `CHOFER` y crea el perfil `Delivery` con `validated = false` e `isActive = false`. |
| 6 | El sistema retorna confirmación al administrador con los datos del chofer creado. |

**Postcondición:** Existe un nuevo usuario con rol CHOFER en el sistema. El perfil Delivery está creado con `validated = false`. El chofer no puede aceptar pedidos ni aparecer en el radar hasta ser validado mediante CU-032.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si algún campo requerido está vacío o el formato es inválido, el sistema informa el error específico por campo. |
| 4 | Si el email ya existe en Firebase Auth, el sistema informa "El email ya está en uso por otro usuario." |
| 5 | Si ocurre un error al persistir en la base de datos, el sistema elimina el usuario creado en Firebase (rollback parcial) e informa error genérico. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-032 — Validar / Invalidar Chofer

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-03 |
| **Descripción** | El administrador habilita o deshabilita definitivamente la operación de un chofer cambiando el flag `validated`. Un chofer con `validated = false` no puede aceptar pedidos ni aparecer en el radar de asignación, independientemente de su estado de disponibilidad. |
| **Precondición** | El administrador está autenticado. El chofer existe en el sistema. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Choferes" → selecciona el chofer a modificar. |
| 2 | Presiona el botón "Validar" (si `validated = false`) o "Invalidar" (si `validated = true`). |
| 3 | El sistema actualiza el campo `Delivery.validated` al valor opuesto. |
| 4 | Si se invalida y el chofer tiene su ubicación en Redis: el sistema ejecuta `ZREM drivers:available driverId` para eliminarlo del radar. |
| 5 | Si se valida: el chofer podrá aparecer en el radar en su próxima activación de disponibilidad (`isActive = true` + GEOADD). |
| 6 | El sistema retorna confirmación al administrador con el estado actualizado. |

**Postcondición:** El flag `Delivery.validated` fue actualizado. Si fue invalidado, el chofer fue eliminado del radar Redis y no puede recibir nuevos pedidos.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el chofer tiene un pedido activo en estado ACCEPTED u ON_THE_WAY y se intenta invalidar, el sistema informa "El chofer tiene una entrega en curso. Finalizá o reasigná el pedido antes de invalidar." |
| 3 | Si el chofer no existe, el sistema retorna error 404. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |
| **Comentarios** | Operación distinta a CU-022 (disponibilidad del chofer) y CU-033 (activar/desactivar admin). `validated` es habilitación permanente dada por el administrador. `isActive` es estado operativo momentáneo controlado por el chofer. |

---

#### 🔴 CU-036 — Crear Producto (Garrafa)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-06 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El administrador registra un nuevo tipo de garrafa en el sistema especificando tipo, precio de venta, stock inicial y descripción opcional. El producto queda activo e inmediatamente disponible en el catálogo de la App Cliente si tiene stock > 0. |
| **Precondición** | El administrador está autenticado en el Panel Web. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Productos" → botón "Nuevo Producto". |
| 2 | Completa el formulario: tipo (ej: "10kg", "15kg", "45kg"), precio de venta, stock inicial y descripción opcional. |
| 3 | El sistema valida que tipo y precio son requeridos, que precio > 0 y stock ≥ 0. |
| 4 | El sistema crea el registro `GasCylinder` con `isActive = true`. |
| 5 | Si el stock ingresado es > 0, el producto aparece inmediatamente en el catálogo de la App Cliente. |
| 6 | El sistema retorna confirmación con los datos del producto creado. |

**Postcondición:** Existe un nuevo `GasCylinder` con `isActive = true`. Si stock > 0, es visible en el catálogo de la App Cliente.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el precio es 0 o negativo, el sistema informa "El precio debe ser mayor a cero." |
| 3 | Si el stock es negativo, el sistema informa "El stock no puede ser negativo." |
| 4 | Si ya existe un producto activo con el mismo tipo, el sistema informa "Ya existe un producto de ese tipo registrado." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🔴 CU-037 — Actualizar Precio de Producto

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-07 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El administrador modifica el precio de venta vigente de un producto. El cambio aplica únicamente a los pedidos futuros; los pedidos ya registrados conservan el precio al momento de su creación almacenado en `OrderItem.unitPrice`. |
| **Precondición** | El administrador está autenticado. El producto existe en el sistema. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Productos" → selecciona el producto a modificar. |
| 2 | Edita el campo "Precio" ingresando el nuevo valor. |
| 3 | El sistema valida que el nuevo precio es un número mayor a cero. |
| 4 | El sistema actualiza `GasCylinder.price` con el nuevo valor. |
| 5 | El nuevo precio se muestra inmediatamente en el catálogo de la App Cliente para nuevos pedidos. |
| 6 | El sistema retorna confirmación al administrador con el precio actualizado. |

**Postcondición:** El campo `GasCylinder.price` fue actualizado. Todos los pedidos futuros usarán el nuevo precio. El historial de pedidos anteriores no se modifica.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el precio ingresado es 0, negativo o no es un número válido, el sistema informa el error específico. |
| 4 | Si el producto no existe, el sistema retorna error 404. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |
| **Comentarios** | La inmutabilidad del precio en pedidos existentes se garantiza porque `OrderItem.unitPrice` almacena el precio al momento de la compra (snapshot), independiente del precio actual del `GasCylinder`. |

---

#### 🔴 CU-038 — Actualizar Stock de Producto

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-06 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El administrador ajusta manualmente el stock disponible de un producto para reflejar una reposición de inventario o una corrección. Si el stock pasa de 0 a un valor positivo, el producto vuelve a aparecer en el catálogo de la App Cliente. |
| **Precondición** | El administrador está autenticado. El producto existe en el sistema. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Productos" → selecciona el producto. |
| 2 | Edita el campo "Stock" ingresando el nuevo valor total (no el incremento, sino el valor absoluto resultante). |
| 3 | El sistema valida que el valor ingresado es un número entero mayor o igual a 0. |
| 4 | El sistema actualiza `GasCylinder.stock` con el nuevo valor. |
| 5 | Si el stock anterior era 0 y el nuevo es > 0, el producto vuelve a ser visible en el catálogo de la App Cliente. |
| 6 | El sistema retorna confirmación al administrador con el stock actualizado. |

**Postcondición:** `GasCylinder.stock` fue actualizado al valor indicado. Si correspondía, el producto volvió a aparecer en el catálogo.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el valor ingresado es negativo, el sistema informa "El stock no puede ser negativo." |
| 3 | Si el valor no es un número entero, el sistema informa error de formato. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |
| **Comentarios** | Este CU gestiona únicamente el ajuste manual de inventario (reposición física). El decremento automático de stock al crear pedidos es responsabilidad del módulo M3 en CU-005 mediante QueryRunner. |

---

#### 🔴 CU-041 — Consultar Catálogo de Productos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-05, OBJ-06 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El cliente visualiza en la App las garrafas activas con stock disponible. El administrador visualiza en el Panel Web el catálogo completo incluyendo productos inactivos y con stock 0. Cada rol recibe una vista diferente del mismo catálogo. |
| **Precondición** | El usuario está autenticado con rol CLIENTE o ADMIN. |

**Secuencia Normal — Actor: Cliente (ACT-01)**

| Paso | Acción |
|------|--------|
| 1 | El cliente abre la App Cliente y accede a la pantalla de catálogo (`MarketView`). |
| 2 | El sistema consulta todos los registros `GasCylinder` donde `isActive = true` y `stock > 0`. |
| 3 | Retorna la lista con: tipo, precio vigente, stock disponible, descripción y promociones por volumen activas. |
| 4 | El cliente selecciona productos y ajusta cantidades. El sistema muestra descuentos por volumen aplicados en tiempo real. |
| 5 | El cliente accede al carrito para proceder al checkout (CU-005). |

**Secuencia Normal — Actor: Administrador (ACT-03)**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → sección "Productos". |
| 2 | El sistema retorna todos los productos sin filtro de estado ni de stock. |
| 3 | Cada producto muestra: tipo, precio actual, stock actual y estado activo/inactivo. |
| 4 | El administrador puede acceder al detalle para editar precio (CU-037), stock (CU-038) o estado (CU-040). |

**Postcondición:** El usuario visualizó el catálogo según su rol. No se producen modificaciones de datos.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si no hay productos activos con stock > 0 (vista Cliente), el sistema muestra "No hay productos disponibles en este momento." |
| 2 | Si ocurre un error de base de datos, el sistema informa error genérico y registra el evento en los logs. |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | La carga del catálogo debe completarse en menos de 2 segundos. |
| **Frecuencia** | Alta — cada vez que un cliente abre la app o el administrador accede a Productos. |
| **Estabilidad** | Alta |

---

### 6.3 Casos de Uso Expandidos — Importantes y Secundarios

> Esta sección contiene **todos los CUs no Críticos** del sistema (Importantes 🟡 y Secundarios ⚪) en **formato Expandido completo** (Objetivos asociados, Requisitos asociados, Descripción, Precondición, Secuencia normal numerada, Postcondición, Excepciones y Estabilidad). La cátedra exige formato Expandido solo para Críticos; aquí se aplica también al resto para garantizar trazabilidad uniforme y facilitar la fase de Análisis y Diseño.

---

#### 🟡 CU-007 — Consultar Historial de Pedidos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-04 |
| **Requisitos asociados** | IRQ-02 |
| **Descripción** | El cliente accede al listado de todos sus pedidos anteriores con posibilidad de filtrado y acceso al detalle. |
| **Precondición** | El cliente está autenticado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cliente accede a la sección "Mis Pedidos" en la App Cliente. |
| 2 | El sistema consulta todos los pedidos donde `customer_id = clienteAutenticado`, ordenados por `createdAt` descendente. |
| 3 | Retorna la lista con datos resumidos: fecha, ítems, total, estado. |
| 4 | El cliente puede tocar cualquier pedido para ver el detalle completo (CU-006). |

**Postcondición:** El cliente visualizó su historial de pedidos.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-008 — Cancelar Pedido (Cliente)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-06 |
| **Requisitos asociados** | IRQ-02, IRQ-04 |
| **Descripción** | El cliente cancela un pedido propio que aún no fue entregado. El stock se restituye automáticamente. |
| **Precondición** | El cliente está autenticado. El pedido le pertenece. El estado del pedido es PENDING o ACCEPTED. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cliente accede al detalle del pedido y selecciona "Cancelar pedido". |
| 2 | Ingresa opcionalmente un motivo de cancelación. |
| 3 | El sistema verifica que el pedido pertenece al cliente y que el estado permite cancelación. |
| 4 | Inicia una transacción: actualiza el estado del pedido a CANCELLED con el motivo, y por cada OrderItem devuelve la cantidad al stock del GasCylinder correspondiente. |
| 5 | Hace commit de la transacción. |
| 6 | Si había chofer asignado: emite `order:cancelled` al chofer por WebSocket y envía FCM push de notificación. |
| 7 | Emite `order:cancelled` al cliente por WebSocket y envía confirmación. |

**Postcondición:** El pedido tiene estado CANCELLED. El stock de todos los ítems fue restituido al inventario dentro de una transacción atómica.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el pedido ya tiene estado ON_THE_WAY, DELIVERED o CANCELLED, el sistema informa "No es posible cancelar el pedido en este estado." |
| 3 | Si el pedido no pertenece al cliente autenticado, el sistema retorna error 403. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-009 — Cancelar Pedido (Chofer)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02 |
| **Requisitos asociados** | IRQ-02 |
| **Descripción** | El chofer que ya aceptó un pedido decide no poder realizarlo. El pedido vuelve a PENDING para que otro chofer pueda tomarlo. El stock NO se restituye. |
| **Precondición** | El chofer está autenticado. El pedido está en estado ACCEPTED y el chofer es el asignado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer accede al pedido activo y selecciona "No puedo realizarlo". |
| 2 | Ingresa obligatoriamente un motivo. |
| 3 | El sistema quita el `delivery_id` del pedido y cambia el estado a PENDING. |
| 4 | Notifica al cliente que se está buscando un nuevo repartidor. |
| 5 | El sistema dispara nuevamente CU-013 para buscar otro chofer disponible. |

**Postcondición:** El pedido tiene estado PENDING sin chofer asignado. El stock no varía. Se busca un nuevo chofer.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-010 — Cancelar Pedido (Administrador)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-06 |
| **Requisitos asociados** | IRQ-02, IRQ-04 |
| **Descripción** | El administrador puede cancelar cualquier pedido activo del sistema con un motivo obligatorio. El stock se restituye automáticamente. |
| **Precondición** | El administrador está autenticado. El pedido existe y su estado es PENDING, ACCEPTED u ON_THE_WAY. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al detalle del pedido en el Panel Web y selecciona "Cancelar pedido". |
| 2 | Ingresa obligatoriamente el motivo de cancelación. |
| 3 | El sistema inicia una transacción: actualiza el estado a CANCELLED con el motivo, y por cada OrderItem devuelve la cantidad al stock del producto. |
| 4 | Hace commit de la transacción. |
| 5 | Notifica al cliente por FCM push: "Tu pedido fue cancelado por el operador. Motivo: [motivo]." |
| 6 | Si había chofer asignado: notifica al chofer por WebSocket y FCM. |

**Postcondición:** El pedido tiene estado CANCELLED. El stock fue restituido. El cliente y el chofer fueron notificados.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si el pedido ya está DELIVERED o CANCELLED, el sistema informa "No se puede cancelar un pedido ya finalizado." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-011 — Listar Todos los Pedidos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05 |
| **Requisitos asociados** | IRQ-02 |
| **Descripción** | El administrador visualiza todos los pedidos del sistema con filtros y paginación. |
| **Precondición** | El administrador está autenticado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → sección "Pedidos". |
| 2 | El sistema devuelve la lista paginada de todos los pedidos, ordenados por `createdAt` descendente. |
| 3 | El administrador puede filtrar por: estado del pedido, rango de fechas (startDate / endDate), chofer asignado. |
| 4 | Cada ítem de la lista muestra: fecha, cliente, total, estado, chofer asignado. |
| 5 | El administrador puede acceder al detalle de cualquier pedido (CU-006). |

**Postcondición:** El administrador visualizó el listado de pedidos según los filtros aplicados.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-023 — Registrar Reclamo

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-04 |
| **Requisitos asociados** | IRQ-06 |
| **Descripción** | Después de recibir un pedido, el cliente puede registrar un reclamo indicando el motivo, una descripción y opcionalmente una foto. |
| **Precondición** | El cliente está autenticado. El pedido existe, está DELIVERED y pertenece al cliente. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cliente accede al historial de pedidos y selecciona un pedido entregado. |
| 2 | Selecciona "Registrar reclamo". |
| 3 | Ingresa el motivo (ej: "Fuga de gas"), una descripción detallada y opcionalmente adjunta una foto. |
| 4 | Confirma el envío del reclamo. |
| 5 | El sistema valida que `order.customer_id == customerId` del usuario autenticado. |
| 6 | Crea el registro `Claim` con estado `PENDING`. |
| 7 | Notifica al administrador por FCM push que hay un nuevo reclamo pendiente. |

**Postcondición:** Existe un reclamo con estado PENDING asociado al pedido y al cliente. El administrador fue notificado.

**Excepciones**

| Paso | Acción |
|------|--------|
| 5 | Si el pedido no pertenece al cliente autenticado, el sistema retorna error 403 "No autorizado." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

#### 🟡 CU-019 — Avisar Llegada al Cliente

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-03 |
| **Requisitos asociados** | IRQ-02 |
| **Descripción** | El chofer indica que ha llegado al domicilio del cliente antes de confirmar la entrega. El cliente recibe una notificación inmediata para que esté preparado. |
| **Precondición** | El pedido está en estado ON_THE_WAY. El chofer autenticado es el asignado. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer llega al domicilio del cliente y presiona "Llegué" en su app. |
| 2 | La app envía `PATCH /orders/:id/status` con `{ status: "ARRIVED" }`. |
| 3 | El backend actualiza el estado del pedido a `ARRIVED` y registra `arrivedAt = now()`. |
| 4 | Emite el evento `order:arrived` al cliente por WebSocket (`CustomersGateway`). |
| 5 | Envía notificación FCM push al cliente: "¡Tu repartidor llegó! Preparate para recibirlo." |

**Postcondición:** El pedido tiene estado ARRIVED. El cliente fue notificado de la llegada del chofer.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si el pedido no está en estado ON_THE_WAY, el sistema retorna error 400 "Transición de estado no permitida." |
| 2 | Si el chofer no es el asignado al pedido, el sistema retorna error 403. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-004 — Gestionar Perfil de Usuario

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-02 |
| **Requisitos asociados** | IRQ-01 |
| **Descripción** | El usuario actualiza datos de su perfil (nombre completo y número de teléfono) desde la sección "Mi Perfil" de su app. Los cambios se persisten en el backend inmediatamente y son visibles en próximas sesiones. |
| **Precondición** | El usuario está autenticado en su app correspondiente. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El usuario accede a "Mi Perfil" desde el menú principal de su app. |
| 2 | Edita los campos `fullName` y/o `phoneNumber`. |
| 3 | Presiona "Guardar cambios". |
| 4 | La app envía `PATCH /users/me` con los campos modificados. |
| 5 | El backend valida los datos: nombre no vacío, teléfono con formato válido. |
| 6 | Actualiza el registro `User` en la base de datos. |
| 7 | Retorna confirmación con los datos actualizados. |
| 8 | La app muestra el perfil actualizado. |

**Postcondición:** El perfil del usuario fue actualizado con los nuevos datos.

**Excepciones**

| Paso | Acción |
|------|--------|
| 5 | Si el formato del teléfono es inválido → 400 "Formato de teléfono inválido." |
| 5 | Si el nombre está vacío → 400 "El nombre es requerido." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### ⚪ CU-012 — Asignar Chofer Manualmente

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El administrador asigna manualmente un chofer validado y activo a un pedido en estado PENDING. Útil cuando el despacho automático no encontró candidatos o cuando se requiere una asignación específica por logística. |
| **Precondición** | El administrador está autenticado. El pedido existe en estado PENDING sin chofer asignado. Existe al menos un chofer con `validated = true` y `isActive = true`. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Pedidos" → selecciona el pedido sin asignar. |
| 2 | Presiona "Asignar chofer manualmente". |
| 3 | El sistema muestra el listado de choferes con `validated = true` y `isActive = true`. |
| 4 | El administrador selecciona el chofer y confirma. |
| 5 | El backend ejecuta `POST /orders/:id/assign-driver` con `{ driverId }`. |
| 6 | Actualiza `Order.delivery_id = driverId` y `Order.status = ACCEPTED`. |
| 7 | Notifica al chofer asignado por WebSocket (`order:assigned`) y FCM push. |
| 8 | Notifica al cliente por WebSocket (`order:accepted`) con datos del chofer. |

**Postcondición:** El pedido tiene estado ACCEPTED con el chofer seleccionado asignado. El chofer y el cliente fueron notificados.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si el chofer ya fue desactivado entre los pasos 3 y 4 → 400 "El chofer ya no está disponible." |
| 6 | Si el pedido cambió de estado (ej: cancelado) → 400 "El pedido ya no está en estado PENDING." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-016 — Rechazar / Ignorar Pedido

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02 |
| **Requisitos asociados** | IRQ-02, IRQ-04 |
| **Descripción** | El chofer decide no aceptar el pedido que le fue notificado por proximidad. Puede rechazar explícitamente (botón "Rechazar") o ignorar dejando vencer el temporizador. El sistema registra el rechazo y reenvía el pedido al siguiente chofer disponible. |
| **Precondición** | El chofer recibió un evento `order:new` por WebSocket o FCM. El pedido está en estado PENDING. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El chofer recibe la notificación con datos del pedido en `OrderInfoBottomSheet`. |
| 2 | Presiona "Rechazar" o deja vencer el temporizador de 30 segundos. |
| 3 | La app envía `POST /orders/:id/reject` con `{ reason }` (opcional). |
| 4 | El backend registra el rechazo en `Order.rejectedDriverIds[]` para no reintentarle al mismo chofer. |
| 5 | El pedido continúa en estado PENDING. |
| 6 | `DispatchService` busca el siguiente chofer cercano excluyendo los ya rechazados. |
| 7 | Si no hay otro chofer cercano: la orden queda esperando al cron M2 (CU-014). |

**Postcondición:** El pedido permanece en estado PENDING. El chofer queda excluido de futuras notificaciones para esa orden específica.

**Excepciones**

| Paso | Acción |
|------|--------|
| 3 | Si el pedido ya fue aceptado por otro chofer → 409 "El pedido ya fue tomado." |
| 3 | Si el pedido fue cancelado → 410 "El pedido ya no está disponible." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-024 — Listar Reclamos

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-04, OBJ-05 |
| **Requisitos asociados** | IRQ-06 |
| **Descripción** | El administrador visualiza el listado completo de reclamos del sistema ordenados por fecha de creación descendente. Permite filtrar por estado (PENDING, RESOLVED, REJECTED) y acceder al detalle de cada reclamo para resolverlo (CU-025). |
| **Precondición** | El administrador está autenticado en el Panel Web. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede a la sección "Reclamos" del Panel Web. |
| 2 | El sistema ejecuta `GET /claims?status=&page=` con paginación. |
| 3 | El backend retorna el listado paginado: `{ id, customerName, orderId, motivo, status, createdAt }`. |
| 4 | El administrador puede filtrar por estado (PENDING / RESOLVED / REJECTED) o por rango de fechas. |
| 5 | El administrador puede acceder al detalle de cualquier reclamo (modal) para ver descripción, foto e historial. |

**Postcondición:** El administrador visualizó el listado de reclamos según los filtros aplicados. No se producen modificaciones de datos.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-025 — Resolver Reclamo

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-04, OBJ-05 |
| **Requisitos asociados** | IRQ-06 |
| **Descripción** | El administrador revisa un reclamo en estado PENDING y decide su resolución. Cambia el estado a RESOLVED o REJECTED, ingresa una nota de resolución obligatoria con el detalle de la decisión y el cliente recibe una notificación con el resultado. |
| **Precondición** | El administrador está autenticado. El reclamo existe en estado PENDING. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al detalle del reclamo desde la sección "Reclamos" (CU-024). |
| 2 | Lee la descripción, motivo y foto adjunta (si la hay). |
| 3 | Selecciona "Resolver" o "Rechazar" e ingresa la nota de resolución. |
| 4 | Confirma la acción. La app envía `PATCH /claims/:id/resolve` con `{ status, resolutionNote }`. |
| 5 | El backend valida que el reclamo está en PENDING y que la nota no esté vacía. |
| 6 | Actualiza `Claim.status` y `Claim.resolutionNote` y registra `resolvedAt = now()`. |
| 7 | Envía notificación FCM push al cliente con el resultado: "Tu reclamo fue resuelto/rechazado. Motivo: [nota]." |

**Postcondición:** El reclamo tiene estado RESOLVED o REJECTED con nota de resolución registrada. El cliente fue notificado.

**Excepciones**

| Paso | Acción |
|------|--------|
| 5 | Si el reclamo ya está resuelto → 400 "El reclamo ya fue procesado." |
| 5 | Si la nota está vacía → 400 "La nota de resolución es obligatoria." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-026 — Ver Dashboard General

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-07 |
| **Requisitos asociados** | IRQ-07 |
| **Descripción** | El administrador accede al panel de control con los KPIs principales del negocio: total de pedidos del día, ventas del día/semana/mes, choferes activos en tiempo real y gráfico de evolución de los últimos 7 días. Los datos se calculan en backend al momento del request y se renderizan con widgets visuales. |
| **Precondición** | El administrador está autenticado en el Panel Web. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web (ruta `/dashboard`). |
| 2 | El frontend ejecuta `GET /stats/overview` en paralelo con `GET /stats/sales-chart?days=7`. |
| 3 | Backend `ReportsService` calcula: pedidos del día, ventas día/semana/mes, choferes activos (con `isActive = true`), top productos. |
| 4 | Backend retorna un objeto con KPIs y serie temporal de 7 días. |
| 5 | El frontend renderiza tarjetas KPI, lista de choferes activos y gráfico (Recharts/Chart.js). |
| 6 | Los datos pueden refrescarse manualmente con un botón "Actualizar". |

**Postcondición:** El administrador visualizó el resumen operativo actualizado del sistema. No se producen modificaciones de datos.

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | Carga del dashboard < 3 segundos. |
| **Frecuencia** | Alta — cada vez que el administrador entra al Panel Web. |
| **Estabilidad** | Alta |

---

#### 🟡 CU-027 — Ver Reporte de Ventas por Chofer

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-07 |
| **Requisitos asociados** | IRQ-07 |
| **Descripción** | El administrador genera un reporte de performance por cada chofer activo en un rango de fechas configurable. Para cada chofer muestra: cantidad de pedidos entregados, monto total vendido, calificación promedio y tiempo promedio de entrega. |
| **Precondición** | El administrador está autenticado. Existen pedidos en estado DELIVERED en el rango de fechas. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede a "Reportes" → "Por Chofer" en el Panel Web. |
| 2 | Configura el rango de fechas (`startDate`, `endDate`). Por defecto, el último mes. |
| 3 | Presiona "Generar reporte". La app envía `GET /stats/by-driver?startDate=&endDate=`. |
| 4 | El backend agrupa pedidos DELIVERED por `delivery_id` y calcula totales y promedios. |
| 5 | Retorna un array con `{ driverId, driverName, deliveriesCount, totalAmount, avgRating, avgDeliveryTime }`. |
| 6 | El frontend renderiza una tabla ordenada por monto vendido descendente, con opción de exportar a CSV. |

**Postcondición:** El administrador visualizó el reporte de rendimiento por chofer para el período seleccionado.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si no hay pedidos en el rango → retorna array vacío y la UI muestra "Sin datos". |
| 4 | Si `endDate < startDate` → 400 "Rango de fechas inválido." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-028 — Ver Reporte de Ventas por Producto

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-07 |
| **Requisitos asociados** | IRQ-07 |
| **Descripción** | El administrador genera un reporte de ventas agrupado por tipo de garrafa en un rango de fechas configurable. Para cada producto muestra: unidades vendidas, monto total facturado, descuentos aplicados y porcentaje de participación en el total. |
| **Precondición** | El administrador está autenticado. Existen pedidos DELIVERED en el rango. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede a "Reportes" → "Por Producto". |
| 2 | Configura rango de fechas y presiona "Generar". |
| 3 | La app envía `GET /stats/by-product?startDate=&endDate=`. |
| 4 | El backend agrupa `OrderItems` de pedidos DELIVERED por `gasCylinderId` y suma cantidades y subtotales. |
| 5 | Retorna un array con `{ productId, productType, unitsSold, totalAmount, totalDiscounts, percentageOfSales }`. |
| 6 | El frontend renderiza una tabla y un gráfico de torta de participación por producto. |

**Postcondición:** El administrador visualizó el reporte de ventas por producto para el período seleccionado.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si no hay pedidos en el rango → retorna array vacío y la UI muestra "Sin datos". |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### ⚪ CU-029 — Ver Reporte por Método de Pago

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-07 |
| **Requisitos asociados** | IRQ-07 |
| **Descripción** | El administrador visualiza la distribución de pedidos y montos totales por método de pago (CASH, MERCADOPAGO, TRANSFER) en un rango de fechas. Permite analizar las preferencias de pago de los clientes y optimizar los métodos ofrecidos. |
| **Precondición** | El administrador está autenticado. Existen pedidos en el rango de fechas. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede a "Reportes" → "Por Método de Pago". |
| 2 | Configura el rango de fechas y presiona "Generar". |
| 3 | La app envía `GET /stats/by-payment-method?startDate=&endDate=`. |
| 4 | El backend agrupa pedidos por `paymentMethod` y suma cantidad y monto. |
| 5 | Retorna `[{ method, count, totalAmount, percentageOfTotal }]`. |
| 6 | El frontend renderiza una tabla y un gráfico de torta. |

**Postcondición:** El administrador visualizó el reporte de distribución por método de pago.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### ⚪ CU-030 — Ver Gráfico de Ventas (últimos 7 días)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-07 |
| **Requisitos asociados** | IRQ-07 |
| **Descripción** | El sistema renderiza automáticamente en el Dashboard un gráfico de barras o líneas con los montos de ventas diarios de los últimos 7 días calendario. Permite identificar tendencias de demanda y picos de actividad recientes. |
| **Precondición** | El administrador está autenticado y accedió al Dashboard. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Dashboard (CU-026). |
| 2 | El frontend ejecuta `GET /stats/sales-chart?days=7` automáticamente. |
| 3 | El backend genera una serie temporal: para cada uno de los últimos 7 días, suma `Order.totalAmount` de pedidos DELIVERED. |
| 4 | Retorna `[{ date: "YYYY-MM-DD", totalAmount, ordersCount }]`. |
| 5 | El frontend renderiza el gráfico con Recharts/Chart.js mostrando la evolución diaria. |

**Postcondición:** El administrador visualizó el gráfico de ventas de los últimos 7 días.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-033 — Activar / Desactivar Chofer (Admin)

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-03 |
| **Descripción** | El administrador modifica manualmente el campo `isActive` del chofer desde el Panel Web. Esta acción es independiente del toggle de disponibilidad que controla el propio chofer desde su app. Útil para suspender operativamente a un chofer sin invalidarlo permanentemente. |
| **Precondición** | El administrador está autenticado. El chofer existe con `validated = true`. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Choferes" → selecciona el chofer. |
| 2 | Presiona el toggle "Activar" o "Desactivar". |
| 3 | La app envía `PATCH /delivery/:id/toggle-active`. |
| 4 | El backend invierte `Delivery.isActive`. |
| 5 | Si pasó a `false`: ejecuta `RedisService.zRem('drivers:available', deliveryId)` para quitarlo del radar. |
| 6 | Si pasó a `true`: el chofer podrá aparecer en el radar al activar disponibilidad desde su app. |

**Postcondición:** El campo `isActive` del chofer fue actualizado. Si fue desactivado, ya no recibe asignaciones automáticas.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si el chofer tiene un pedido en curso (ACCEPTED/ON_THE_WAY) y se intenta desactivar → 400 "El chofer tiene una entrega en curso." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-034 — Registrar Vehículo del Chofer

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-03 |
| **Descripción** | El administrador registra el vehículo operativo de un chofer ingresando: tipo (moto/auto/camioneta), patente (única en el sistema), marca, modelo, año, color y capacidad de carga en unidades. El vehículo queda asociado al perfil del chofer. |
| **Precondición** | El administrador está autenticado. El chofer existe en el sistema. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Choferes" → selecciona el chofer → "Registrar vehículo". |
| 2 | Completa el formulario: `type`, `patent`, `brand`, `model`, `year`, `color`, `capacity`. |
| 3 | Confirma. La app envía `POST /cars` con el DTO completo. |
| 4 | El backend valida que la patente no exista ya en el sistema. |
| 5 | Crea el registro `Car` y lo asocia al `User` del chofer. |
| 6 | Retorna confirmación con los datos del vehículo creado. |

**Postcondición:** El vehículo queda registrado y asociado al perfil del chofer.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si la patente ya existe → 409 "La patente ya está registrada en el sistema." |
| 4 | Si algún campo requerido está vacío → 400 con detalle del campo. |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-035 — Consultar Listado de Choferes

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-02, OBJ-05 |
| **Requisitos asociados** | IRQ-03 |
| **Descripción** | El administrador visualiza el listado completo de choferes registrados en el sistema con su estado de validación, disponibilidad en tiempo real, datos de contacto, vehículo asignado y calificación promedio. Permite filtrar por estado y acceder al detalle de cada chofer. |
| **Precondición** | El administrador está autenticado en el Panel Web. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Choferes". |
| 2 | El frontend ejecuta `GET /delivery?validated=&isActive=&page=`. |
| 3 | El backend retorna paginado con join: `{ id, fullName, email, phone, validated, isActive, calification, car: {...} }`. |
| 4 | El administrador puede filtrar por validado/no validado, activo/inactivo. |
| 5 | Cada chofer muestra: nombre, email, teléfono, estado, vehículo asignado, calificación promedio. |
| 6 | El administrador puede acceder al detalle de cualquier chofer para gestionar (CU-032, CU-033, CU-034). |

**Postcondición:** El administrador visualizó el listado de choferes. No se producen modificaciones de datos.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-039 — Configurar Promociones por Cantidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-06 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El administrador define descuentos automáticos por volumen para un producto, especificando la cantidad mínima de unidades y el porcentaje de descuento. Las promociones activas se almacenan como JSONB en `GasCylinder.promotions` y se aplican automáticamente al calcular el subtotal en el checkout. |
| **Precondición** | El administrador está autenticado. El producto existe en el sistema. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Productos" → selecciona un producto → "Promociones". |
| 2 | Define las reglas: por ejemplo `[{ quantity: 3, discountPercentage: 5 }, { quantity: 10, discountPercentage: 10 }]`. |
| 3 | Confirma. La app envía `PATCH /gas-cylinders/:id` con el array `promotions`. |
| 4 | El backend valida que cada regla tenga `quantity > 0` y `0 < discountPercentage <= 50`. |
| 5 | Persiste el array en `GasCylinder.promotions` (jsonb). |
| 6 | El catálogo de App Cliente refleja el descuento al alcanzar la cantidad mínima. |

**Postcondición:** La promoción queda activa para el producto. Los próximos pedidos aplican el descuento automáticamente al alcanzar la cantidad mínima.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si `discountPercentage > 50` → 400 "El descuento máximo permitido es 50%." |
| 4 | Si `quantity <= 0` → 400 "La cantidad mínima debe ser mayor a cero." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-040 — Activar / Desactivar Producto

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05, OBJ-06 |
| **Requisitos asociados** | IRQ-04 |
| **Descripción** | El administrador cambia el flag `isActive` del producto. Un producto con `isActive = false` no aparece en el catálogo de la App Cliente ni puede ser seleccionado en nuevos pedidos. El stock se conserva intacto para futuras reactivaciones. |
| **Precondición** | El administrador está autenticado. El producto existe en el sistema. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Productos" → selecciona un producto. |
| 2 | Presiona el toggle "Activar / Desactivar". |
| 3 | La app envía `PATCH /gas-cylinders/:id/toggle-active`. |
| 4 | El backend invierte `GasCylinder.isActive`. |
| 5 | Persiste el cambio. El catálogo de App Cliente excluye productos inactivos en el siguiente refresh. |

**Postcondición:** `GasCylinder.isActive` fue actualizado. Si fue desactivado, ya no es visible en el catálogo del cliente. El stock se conserva.

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-042 — Crear Franja Horaria

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-04, OBJ-05 |
| **Requisitos asociados** | IRQ-09 |
| **Descripción** | El administrador crea una franja horaria de entrega especificando nombre descriptivo, hora de inicio, hora de fin y capacidad máxima de pedidos por día. Las franjas activas con capacidad disponible se muestran al cliente durante el checkout. |
| **Precondición** | El administrador está autenticado en el Panel Web. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Franjas Horarias" → "Nueva franja". |
| 2 | Completa: `name` (ej: "Mañana 8–12"), `startTime`, `endTime`, `capacity`. |
| 3 | Confirma. La app envía `POST /time-slots` con el DTO. |
| 4 | El backend valida que `endTime > startTime` y `capacity > 0`. |
| 5 | Persiste el registro `TimeSlot` con `isActive = true`. |
| 6 | Retorna confirmación con la franja creada. |

**Postcondición:** La franja horaria queda activa y disponible para que los clientes la seleccionen al crear pedidos.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si `endTime <= startTime` → 400 "La hora de fin debe ser posterior a la de inicio." |
| 4 | Si `capacity <= 0` → 400 "La capacidad debe ser mayor a cero." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-043 — Modificar Capacidad de Franja Horaria

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-04, OBJ-05 |
| **Requisitos asociados** | IRQ-09 |
| **Descripción** | El administrador actualiza la capacidad máxima de pedidos por día de una franja horaria existente para ajustarla a la disponibilidad operativa real (por ejemplo, al sumar choferes o al disminuir capacidad logística). |
| **Precondición** | El administrador está autenticado. La franja horaria existe. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El administrador accede al Panel Web → "Franjas Horarias" → selecciona una franja. |
| 2 | Edita el campo `capacity` con el nuevo valor. |
| 3 | Confirma. La app envía `PATCH /time-slots/:id` con `{ capacity }`. |
| 4 | El backend valida que `capacity > 0`. |
| 5 | Actualiza `TimeSlot.capacity` y persiste. |
| 6 | Las consultas de disponibilidad futuras (CU-045) usan el nuevo límite. |

**Postcondición:** La capacidad de la franja fue actualizada. Los pedidos futuros se validan contra el nuevo límite.

**Excepciones**

| Paso | Acción |
|------|--------|
| 4 | Si `capacity <= 0` → 400 "La capacidad debe ser mayor a cero." |
| 4 | Si la franja ya tiene más pedidos que la nueva capacidad para una fecha → advertencia (no bloquea). |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-044 — Seleccionar Franja Horaria al Crear Pedido

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-04 |
| **Requisitos asociados** | IRQ-09 |
| **Descripción** | Durante el checkout, el cliente debe elegir una franja horaria de entrega disponible para la fecha solicitada. El sistema muestra únicamente las franjas con capacidad remanente, calculadas en tiempo real al consultar disponibilidad (CU-045). |
| **Precondición** | El cliente está autenticado, en `CheckoutView` con ítems en el carrito y fecha de entrega seleccionada. |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cliente accede al `CheckoutView` y selecciona una fecha de entrega. |
| 2 | El sistema invoca CU-045 para obtener las franjas disponibles para esa fecha. |
| 3 | La UI muestra solo las franjas con `availableSlots > 0`, agrupadas por nombre. |
| 4 | El cliente selecciona una franja (radio button). |
| 5 | El `CheckoutViewModel` registra `timeSlotId` en el DTO del pedido. |
| 6 | Al confirmar (CU-005), el backend asocia `Order.time_slot_id` y descuenta capacidad. |

**Postcondición:** El pedido queda asociado a la franja horaria seleccionada. La capacidad remanente disminuye en uno para esa franja y fecha.

**Excepciones**

| Paso | Acción |
|------|--------|
| 6 | Si entre el paso 4 y 6 la franja se llenó (race condition) → 409 "Franja sin capacidad disponible. Volvé a elegir." |

| Campo | Detalle |
|-------|---------|
| **Estabilidad** | Alta |

---

#### 🟡 CU-045 — Consultar Franjas Horarias Disponibles

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-04 |
| **Requisitos asociados** | IRQ-09 |
| **Descripción** | El sistema calcula y retorna las franjas horarias con capacidad remanente para una fecha específica consultada durante el checkout. Una franja está disponible cuando el conteo de pedidos ya registrados para esa fecha y franja es estrictamente menor a su capacidad máxima. |
| **Precondición** | El cliente está autenticado y consulta una fecha de entrega válida (≥ hoy). |

**Secuencia Normal**

| Paso | Acción |
|------|--------|
| 1 | El cliente selecciona una fecha en el `CheckoutView`. |
| 2 | La app envía `GET /time-slots/availability?date=YYYY-MM-DD`. |
| 3 | El backend obtiene todas las `TimeSlot` con `isActive = true`. |
| 4 | Para cada franja, cuenta los pedidos no cancelados con esa fecha y franja. |
| 5 | Calcula `availableSlots = capacity − ordersCount`. |
| 6 | Retorna `[{ id, name, startTime, endTime, capacity, availableSlots }]`. |
| 7 | El frontend muestra solo las franjas con `availableSlots > 0`. |

**Postcondición:** El cliente visualizó las opciones de franja disponibles para la fecha seleccionada. No se producen modificaciones de datos.

**Excepciones**

| Paso | Acción |
|------|--------|
| 2 | Si la fecha es anterior a hoy → 400 "La fecha debe ser igual o posterior a hoy." |
| 7 | Si todas las franjas están llenas → la UI muestra "No hay franjas disponibles para esa fecha. Probá con otra." |

| Campo | Detalle |
|-------|---------|
| **Rendimiento** | Cálculo de disponibilidad < 1 segundo. |
| **Estabilidad** | Alta |

---

## 7. Requisitos No Funcionales

### 🔴 NFR-01 — Seguridad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-05 |
| **Descripción** | El sistema debe garantizar que cada usuario solo acceda a las funcionalidades y datos correspondientes a su rol. Toda comunicación HTTP y WebSocket debe estar autenticada. |
| **Especificación** | Autenticación basada en JWT firmado con HS256. Roles diferenciados: CLIENTE, CHOFER, ADMIN. Guards NestJS: `JwtAuthGuard`, `RolesGuard`, `OwnershipGuard`. Las conexiones WebSocket requieren JWT válido en el handshake. Las contraseñas se gestionan exclusivamente a través de Firebase Auth. La sesión del Panel Web usa cookie `httpOnly` para prevenir ataques XSS. |
| **Estabilidad** | Alta |

### 🔴 NFR-02 — Rendimiento

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-03 |
| **Descripción** | El sistema debe responder con tiempos aceptables para no degradar la experiencia del usuario. |
| **Especificación** | Login: < 3 segundos. Creación de pedido: < 5 segundos. Consulta de choferes cercanos en Redis: < 500ms. Actualización de ubicación GPS en Redis: < 100ms. Carga del catálogo de productos: < 2 segundos. Consulta del dashboard: < 3 segundos. |
| **Estabilidad** | Alta |

### 🟡 NFR-03 — Disponibilidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01, OBJ-02 |
| **Descripción** | El sistema debe estar disponible durante el horario operativo del distribuidor (estimado 8:00 – 21:00 hs). |
| **Especificación** | El sistema se despliega con Docker Compose con la política `restart: always` en todos los contenedores, lo que permite reinicio automático ante caídas. El entorno on-premise del cliente debe garantizar conectividad a internet estable. Se acepta mantenimiento programado fuera del horario operativo. |
| **Estabilidad** | Alta |

### 🟡 NFR-04 — Escalabilidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05 |
| **Descripción** | La arquitectura debe soportar crecimiento en la cantidad de usuarios y pedidos en futuras fases sin rediseño. |
| **Especificación** | El backend usa el adaptador Redis para Socket.IO (`redis-io.adapter`) que permite correr múltiples instancias del servidor NestJS sin pérdida de eventos WebSocket. La containerización con Docker facilita el escalado horizontal. PostgreSQL y Redis son desplegables en nodos separados si el volumen lo requiere. |
| **Estabilidad** | Alta |

### 🟡 NFR-05 — Portabilidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01 |
| **Descripción** | Las apps móviles deben funcionar en los sistemas operativos móviles más usados por el mercado objetivo. |
| **Especificación** | Las apps (Cliente y Chofer) se desarrollan con Flutter, compilando nativamente para Android (versión 8.0 / API 26+) e iOS (versión 14+) desde una única base de código Dart. |
| **Estabilidad** | Alta |

### 🟡 NFR-06 — Usabilidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-01 |
| **Descripción** | Las interfaces deben ser intuitivas para usuarios con conocimientos tecnológicos básicos (perfil típico de cliente de distribuidora de gas). |
| **Especificación** | El flujo de creación de pedido no debe requerir más de 5 pasos. Las notificaciones deben usar lenguaje claro, en español argentino. Los estados del pedido deben ser visualmente distinguibles con iconos y colores. La App Chofer debe permitir gestionar una entrega completa con no más de 3 toques de pantalla por acción. |
| **Estabilidad** | Alta |

### 🟡 NFR-07 — Mantenibilidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-05 |
| **Descripción** | El código fuente debe ser comprensible, modular y fácil de modificar para agregar nuevas funcionalidades en fases posteriores. |
| **Especificación** | El backend NestJS está organizado en módulos independientes por dominio (auth, order, dispatch, delivery, etc.) siguiendo principios SOLID. Las apps Flutter usan arquitectura MVVM con Stacked, separando la UI de la lógica de negocio. El Panel Admin React usa componentes reutilizables con Material UI. Todas las entidades están mapeadas con TypeORM para facilitar la evolución del esquema de base de datos. |
| **Estabilidad** | Alta |

### 🟡 NFR-08 — Confiabilidad

| Campo | Detalle |
|-------|---------|
| **Objetivos asociados** | OBJ-06, OBJ-04 |
| **Descripción** | El sistema debe garantizar la integridad de los datos críticos (stock y pedidos) incluso ante fallas parciales. |
| **Especificación** | La reserva y restitución de stock se realizan dentro de transacciones PostgreSQL explícitas (QueryRunner con BEGIN / COMMIT / ROLLBACK). No puede existir stock comprometido sin pedido válido. El sistema usa lock pesimista (`SELECT FOR UPDATE`) para prevenir condiciones de carrera. Los totales monetarios se calculan con `decimal.js` para garantizar precisión decimal exacta. |
| **Estabilidad** | Alta |

---

## 8. Matriz de Rastreabilidad Objetivos / Requisitos

|  | OBJ-01 | OBJ-02 | OBJ-03 | OBJ-04 | OBJ-05 | OBJ-06 | OBJ-07 | OBJ-08 |
|--|:------:|:------:|:------:|:------:|:------:|:------:|:------:|:------:|
| **IRQ-01** | ✅ | | | | ✅ | | | |
| **IRQ-02** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | |
| **IRQ-03** | | ✅ | ✅ | | ✅ | | | |
| **IRQ-04** | ✅ | | | | ✅ | ✅ | | |
| **IRQ-05** | ✅ | | | | | | | ✅ |
| **IRQ-06** | | | | ✅ | ✅ | | | |
| **IRQ-07** | ✅ | ✅ | | | | | | |
| **IRQ-08** | ✅ | | | | | | ✅ | |
| **CU-001** | ✅ | ✅ | | | ✅ | | | |
| **CU-002** | ✅ | | | | | | | |
| **CU-003** | | | | | ✅ | | | |
| **CU-005** | ✅ | ✅ | | | | ✅ | ✅ | ✅ |
| **CU-006** | ✅ | | ✅ | ✅ | ✅ | | | |
| **CU-007** | ✅ | | | ✅ | | | | |
| **CU-008** | ✅ | | | | | ✅ | | |
| **CU-009** | | ✅ | | | | | | |
| **CU-010** | | | | | ✅ | ✅ | | |
| **CU-011** | | | | | ✅ | | | |
| **CU-013** | | ✅ | | | | | | |
| **CU-014** | | ✅ | | | | | | |
| **CU-015** | | ✅ | ✅ | | | | | |
| **CU-017** | | ✅ | ✅ | | | | | |
| **CU-018** | | | ✅ | | | | | |
| **CU-019** | | | ✅ | | | | | |
| **CU-020** | | | ✅ | ✅ | | | | |
| **CU-021** | ✅ | | ✅ | | | | | |
| **CU-022** | | ✅ | | | | | | |
| **CU-023** | | | | ✅ | ✅ | | | |
| **CU-026** | | | | | ✅ | | | |
| **CU-027** | | | | | ✅ | | | |
| **CU-028** | | | | | ✅ | | | |
| **CU-036** | | | | | ✅ | ✅ | | |
| **CU-037** | | | | | ✅ | | ✅ | |
| **CU-038** | | | | | ✅ | ✅ | | |
| **CU-041** | ✅ | | | | ✅ | ✅ | | |
| **CU-042** | ✅ | | | | ✅ | | | ✅ |
| **CU-044** | ✅ | | | | | | | ✅ |
| **NFR-01** | ✅ | | | | ✅ | | | |
| **NFR-02** | ✅ | ✅ | ✅ | | | | | |
| **NFR-03** | ✅ | ✅ | | | | | | |
| **NFR-04** | | | | | ✅ | | | |
| **NFR-05** | ✅ | | | | | | | |
| **NFR-06** | ✅ | | | | | | | |
| **NFR-07** | | | | | ✅ | | | |
| **NFR-08** | | | | ✅ | | ✅ | | |

---

## 9. Glosario de Términos

| Término | Categoría | Descripción |
|---------|-----------|-------------|
| Garrafa | Dominio | Recipiente metálico presurizado que contiene Gas Licuado de Petróleo (GLP). Se comercializa por peso: 10 kg, 15 kg y 45 kg. Producto principal del sistema. |
| Chofer / Repartidor | Actor | Empleado del distribuidor encargado de transportar y entregar garrafas en el domicilio del cliente usando la App Chofer. |
| Distribuidor | Dominio | Empresa que comercializa y reparte garrafas de gas. Cliente del sistema SPLG. Opera con una flota propia de choferes. |
| Franja horaria | Dominio | Rango de horas del día habilitado para recepcionar y efectuar entregas (ej: Mañana 9–13 hs). Tiene una capacidad máxima de pedidos por día. |
| Despacho automático | Proceso | Algoritmo que detecta y notifica automáticamente al chofer elegible más cercano cuando se crea un pedido. Implementado con Redis GEORADIUS. |
| Radar de choferes | Proceso | Estructura de datos en Redis (Sorted Set GEO) que almacena la posición GPS de los choferes activos. Permite consultas de proximidad en tiempo real con GEORADIUS. |
| Redis | Tecnología | Base de datos en memoria (in-memory) usada para almacenar ubicaciones GPS de choferes y gestionar el radar de proximidad. Latencia típica < 1ms. |
| GEORADIUS | Tecnología | Comando Redis que retorna los miembros de un Sorted Set GEO dentro de un radio especificado, opcionalmente ordenados por distancia. |
| GEOADD | Tecnología | Comando Redis que agrega o actualiza la posición geoespacial de un miembro en un Sorted Set GEO. |
| ZREM | Tecnología | Comando Redis que elimina un miembro de un Sorted Set. Usado para quitar al chofer del radar cuando se desactiva. |
| WebSocket | Tecnología | Protocolo de comunicación bidireccional y persistente que permite notificaciones en tiempo real entre el servidor y las apps sin polling. Implementado con Socket.IO. |
| JWT | Tecnología | JSON Web Token. Credencial firmada digitalmente (HS256) que identifica al usuario autenticado y contiene su rol. Incluye `userId`, `email` y `role`. |
| FCM | Tecnología | Firebase Cloud Messaging. Servicio de Google para el envío de notificaciones push a dispositivos móviles. Funciona incluso con la app cerrada. |
| Firebase Auth | Tecnología | Servicio de autenticación de Google que gestiona usuarios y contraseñas. El sistema delega completamente la verificación de credenciales a Firebase. |
| Flutter | Tecnología | Framework de Google para desarrollar apps nativas compiladas para Android, iOS y web desde una única base de código Dart. |
| NestJS | Tecnología | Framework Node.js con TypeScript para construir APIs REST escalables, con inyección de dependencias y arquitectura modular. |
| TypeORM | Tecnología | ORM para TypeScript/Node.js que mapea entidades a tablas PostgreSQL y facilita queries, relaciones y migraciones. |
| QueryRunner | Tecnología | Mecanismo de TypeORM para ejecutar múltiples operaciones de base de datos dentro de una misma transacción con control explícito de BEGIN/COMMIT/ROLLBACK. |
| docker-compose | Tecnología | Herramienta para definir y ejecutar aplicaciones multi-contenedor Docker. Permite desplegar backend + PostgreSQL + Redis en un solo comando. |
| decimal.js | Tecnología | Librería JavaScript para aritmética decimal de precisión arbitraria. Usada para cálculos monetarios y evitar errores de punto flotante (`0.1 + 0.2 ≠ 0.3` en JS nativo). |
| Stock | Dominio | Cantidad de garrafas físicamente disponibles en el depósito del distribuidor para ser vendidas. Se gestiona atómicamente por el sistema. |
| Reclamo | Dominio | Queja formal del cliente sobre un pedido recibido. Puede incluir una foto URL como evidencia. Gestionado por el administrador. |
| On-premise | Infraestructura | Modalidad de despliegue donde el servidor se instala físicamente en las instalaciones del cliente, no en la nube pública. |
| PENDING | Estado | Estado inicial de un pedido recién creado. Sin chofer asignado, esperando asignación automática. |
| ACCEPTED | Estado | El chofer aceptó el pedido. En preparación, aún no salió. |
| ON_THE_WAY | Estado | El chofer está en camino al domicilio del cliente. El cliente puede verlo en el mapa. |
| DELIVERED | Estado | El pedido fue entregado exitosamente. Fin del ciclo de entrega. |
| CANCELLED | Estado | El pedido fue cancelado. El stock fue restituido (si canceló Cliente o Admin). |
| Race condition | Técnico | Condición de carrera: situación donde dos procesos simultáneos acceden y modifican el mismo recurso (ej: stock) causando inconsistencias. Se previene con lock pesimista. |
| httpOnly cookie | Técnico | Cookie que el navegador no puede leer con JavaScript, protegiéndola contra ataques XSS (Cross-Site Scripting). Usada para la sesión del Panel Web. |
| Stacked MVVM | Arquitectura | Patrón Model-View-ViewModel implementado con el paquete `stacked` en Flutter. Separa la lógica de negocio (ViewModel) de la interfaz (View) con inyección de dependencias via `get_it`. |
| Webhook | Integración | Endpoint HTTP del backend que recibe notificaciones automáticas de MercadoPago cuando el estado de un pago cambia (aprobado, rechazado, expirado). |
