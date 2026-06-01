# Documento de Análisis — Fase II
**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas
**Versión:** 1.0
**Fecha:** 2026-04-17
**Realizado por:** Nahuel Wagner

---

## Lista de Cambios

| Nro | Fecha | Descripción | Autor |
|-----|-------|-------------|-------|
| 0 | 2026-04-17 | Versión inicial | Nahuel Wagner |

---

## Leyenda

| Indicador | Significado |
|:---------:|-------------|
| 🔴 | Concepto / operación crítica |
| 🟡 | Concepto / operación importante |
| 🤖 | Proceso automático sin intervención humana |

---

## 1. Modelo Conceptual

### 1.1 Lista de Conceptos Candidatos

| Categoría | Ejemplos identificados |
|-----------|----------------------|
| Personas / Roles | Usuario, Cliente, Chofer, Administrador |
| Objetos físicos | Garrafa, Vehículo |
| Transacciones / Eventos | Pedido, ItemPedido, Reclamo, Entrega |
| Contenedores de información | Catálogo, Stock, Reporte |
| Configuración | FranjaHoraria, Promocion |
| Ubicaciones | DireccionEntrega, UbicacionGPS |

---

### 1.2 Lista de Conceptos Idóneos

| Concepto | Símbolo | Intención | Extensión |
|----------|---------|-----------|-----------|
| **Usuario** | Usuario | Persona registrada en el sistema con un rol asignado. | Todos los clientes, choferes y administradores del distribuidor. |
| **Cliente** | Cliente | Perfil extendido de un Usuario con rol CLIENTE. Realiza pedidos. | Toda persona que descarga la App Cliente y se registra. |
| **Chofer** | Chofer | Perfil extendido de un Usuario con rol CHOFER. Ejecuta entregas. | Repartidores del distribuidor habilitados por el administrador. |
| **Administrador** | Admin | Perfil extendido de un Usuario con rol ADMIN. Gestiona el sistema. | Operadores internos del distribuidor con acceso al Panel Web. |
| **Pedido** | Pedido | Solicitud formal de compra realizada por un cliente. Tiene un ciclo de vida de estados. | Cada transacción de compra registrada en el sistema. |
| **ItemPedido** | ItemPedido | Línea individual dentro de un pedido: un producto y su cantidad. | Cada garrafa solicitada dentro de un pedido. |
| **Garrafa** | Garrafa | Producto comercializado por el distribuidor. Tiene precio y stock. | Tipos disponibles: 10kg, 15kg, 45kg. |
| **Entrega** | Entrega | Perfil operativo de un Chofer que registra su estado, ubicación y balance. | Un perfil Entrega por cada Chofer registrado en el sistema. |
| **Vehículo** | Vehiculo | Medio de transporte asociado a un Chofer. | Cada auto, moto o camioneta registrada en el sistema. |
| **DireccionEntrega** | Direccion | Domicilio del cliente guardado para futuras entregas, con coordenadas GPS. | Cada dirección registrada por un cliente. |
| **FranjaHoraria** | FranjaHoraria | Rango de horas del día habilitado para entregas, con capacidad máxima. | Franjas configuradas por el administrador (ej: Mañana, Tarde). |
| **Promocion** | Promocion | Descuento por volumen aplicable a una garrafa al superar una cantidad mínima. | Cada regla de descuento configurada en un producto. |
| **Reclamo** | Reclamo | Queja formal del cliente sobre un pedido entregado, con evidencia opcional. | Cada reclamo registrado en el sistema. |
| **UbicacionGPS** | UbicacionGPS | Coordenadas geográficas (lat/lng) del Chofer en un momento dado. Almacenada en Redis. | La posición actual de cada chofer activo en el radar. |

---

### 1.3 Relaciones entre Conceptos

| Relación | Concepto A | Concepto B | Tipo |
|----------|-----------|-----------|------|
| Es un tipo de | Cliente | Usuario | Herencia / Extensión |
| Es un tipo de | Chofer | Usuario | Herencia / Extensión |
| Es un tipo de | Administrador | Usuario | Herencia / Extensión |
| Realiza | Cliente | Pedido | Asociación (1 a N) |
| Contiene | Pedido | ItemPedido | Composición (1 a N) |
| Referencia | ItemPedido | Garrafa | Asociación (N a 1) |
| Es asignado a | Pedido | Chofer | Asociación (N a 1, nullable) |
| Tiene | Chofer | Entrega | Composición (1 a 1) |
| Tiene | Chofer | Vehiculo | Asociación (1 a N) |
| Pertenece a | Pedido | DireccionEntrega | Asociación (N a 1) |
| Pertenece a | DireccionEntrega | Cliente | Asociación (N a 1) |
| Pertenece a | Pedido | FranjaHoraria | Asociación (N a 1) |
| Tiene | Garrafa | Promocion | Composición (1 a N, jsonb) |
| Pertenece a | Reclamo | Pedido | Asociación (N a 1) |
| Realiza | Cliente | Reclamo | Asociación (1 a N) |
| Representa | Entrega | UbicacionGPS | Asociación temporal (Redis) |

---

### 1.4 Descripción de Atributos

| Concepto | Atributo | Descripción |
|----------|----------|-------------|
| **Usuario** | full_name | Nombre completo del usuario. |
| **Usuario** | email | Email único. Usado para autenticación en Firebase. |
| **Usuario** | phone_number | Teléfono de contacto. |
| **Usuario** | role | Rol del usuario: CLIENTE, CHOFER o ADMIN. |
| **Cliente** | notification_token | Token FCM para recibir push notifications. |
| **Chofer** | validated | Indica si el administrador habilitó al chofer para operar. |
| **Chofer** | isActive | Indica si el chofer está disponible para recibir pedidos en este momento. |
| **Chofer** | calification | Calificación promedio del chofer (asignada por clientes). |
| **Chofer** | balance | Saldo acumulado del chofer. |
| **Pedido** | status | Estado actual: PENDING, ACCEPTED, ON_THE_WAY, DELIVERED, CANCELLED. |
| **Pedido** | totalAmount | Monto total calculado con promociones y recargos. |
| **Pedido** | paymentMethod | Método de pago elegido: CASH, MERCADOPAGO, TRANSFER. |
| **Pedido** | paymentStatus | Estado del pago: PENDING, PAID, FAILED. |
| **Pedido** | deliveryLatitude / deliveryLongitude | Coordenadas del domicilio de entrega. |
| **Pedido** | cancellationReason | Motivo de cancelación (si aplica). |
| **ItemPedido** | quantity | Cantidad de unidades del producto. |
| **ItemPedido** | unitPrice | Precio unitario al momento de la compra. |
| **ItemPedido** | subtotal | quantity × unitPrice. |
| **Garrafa** | type | Tipo de garrafa: "10kg", "15kg", "45kg". |
| **Garrafa** | price | Precio de venta vigente. |
| **Garrafa** | stock | Unidades físicamente disponibles en el depósito. |
| **Garrafa** | promotions | Array de reglas de descuento: `[{ quantity, discountPercentage }]`. |
| **FranjaHoraria** | startTime / endTime | Rango horario de la franja (ej: "09:00" – "13:00"). |
| **FranjaHoraria** | capacity | Máximo de pedidos que acepta la franja en un día. |
| **Reclamo** | reason | Motivo del reclamo (ej: "Fuga de gas"). |
| **Reclamo** | photoUrl | URL de la foto de evidencia (opcional). |
| **Reclamo** | status | Estado: PENDING, IN_PROCESS, RESOLVED, REJECTED. |
| **UbicacionGPS** | lat / lng | Coordenadas geográficas actuales del chofer. Almacenadas en Redis con GEOADD. |

---

### 1.5 Diagrama Conceptual

> **[ INSERTAR IMAGEN: diagrama-conceptual.png ]**
>
> **Instrucciones para draw.io:**
> 1. Crear un diagrama de clases UML en blanco.
> 2. Agregar una clase por cada concepto de la sección 1.2 con sus atributos (sección 1.4).
> 3. No incluir métodos — es un modelo conceptual, no de diseño.
> 4. Conectar las clases según las relaciones de la sección 1.3 usando los conectores UML correspondientes: línea con rombo relleno para composición, línea simple para asociación, línea con triángulo para herencia.
> 5. Agregar multiplicidades en los extremos de cada relación (ej: 1, N, 0..1).
> 6. Agrupar visualmente: Usuario/Cliente/Chofer/Admin en un área, Pedido/Item/Garrafa en otra, y Reclamo/Franja/Dirección en una tercera.

---

## 2. Comportamiento del Sistema

### 2.1 Diagramas de Secuencia a Nivel de Sistema

Los diagramas de secuencia muestran la interacción entre el **actor** y el **sistema tratado como caja negra**. Solo se muestran los mensajes de entrada y salida, sin detallar la implementación interna.

---

#### 🔴 DSS — CU-001: Iniciar Sesión

```
Actor: Usuario (Cliente / Chofer / Administrador)
Sistema: SPLG Backend

Usuario  →  Sistema : login(email, password)
Sistema  →  Firebase Auth : signInWithEmailAndPassword(email, password)
Firebase →  Sistema : firebaseUid
Sistema  →  Base de Datos : SELECT User WHERE firebaseUid = ?
Base de Datos →  Sistema : User { id, role, profileId }
Sistema  →  Sistema : signJWT({ sub: userId, role, profileId })
Sistema  →  Usuario : { accessToken, user }

[Excepciones]
Sistema  →  Usuario : error401 ("Credenciales inválidas")
Sistema  →  Usuario : error403 ("Cuenta pendiente de validación")  ← si CHOFER y validated=false
```

> **[ INSERTAR IMAGEN: dss-cu001-login.png ]**
>
> Instrucciones draw.io: lifelines = Usuario | Sistema | Firebase Auth. Mensajes síncronos. Agregar fragments `alt` para los dos casos de excepción (credenciales inválidas, chofer no validado).

---

#### 🔴 DSS — CU-005: Crear Pedido

```
Actor: Cliente
Sistema: SPLG Backend

Cliente  →  Sistema : crearPedido(customerId, addressId, timeSlotId, items[], paymentMethod, notificationToken)
Sistema  →  Cliente : pedidoConfirmado(orderId, totalAmount, status="PENDING")
Sistema  →  Cliente : [WebSocket] order:driver-found  ← (si hay choferes cercanos)
Sistema  →  Chofer  : [WebSocket] server:new-order-request(orderId, totalAmount, items)
Sistema  →  Cliente : [FCM Push] "¡Pedido Confirmado!"
```

> **[ INSERTAR IMAGEN: dss-cu005-crear-pedido.png ]**
>
> Instrucciones draw.io: lifelines = Cliente | Sistema. Mensajes síncronos hacia el sistema (flecha sólida). Respuestas (flechas punteadas de vuelta). Agregar un `alt` fragment para el caso donde no hay choferes cercanos.

---

#### 🔴 🤖 DSS — CU-013: Asignar Pedido Automáticamente

```
Actor: Sistema (disparado por CU-005)

Sistema  →  Redis   : GEORADIUS(lng, lat, 5km, ASC)
Redis    →  Sistema : [driverId_1, driverId_2, ...]
Sistema  →  Chofer  : [WebSocket] server:new-order-request(orderId, datos)
           (se repite por cada chofer encontrado)

[Si no hay choferes]
Sistema  →  Cliente : [WebSocket] "Buscando repartidor..."
```

> **[ INSERTAR IMAGEN: dss-cu013-despacho-automatico.png ]**

---

#### 🔴 🤖 DSS — CU-014: Reintentar Asignación (Cron)

```
Actor: Sistema (automático — cada 1 minuto)

Sistema  →  Base de Datos : findPendingOrders(status=PENDING, delivery_id=NULL)
Base de Datos  →  Sistema : [pedido_1, pedido_2, ...]
Sistema  →  Sistema       : filtrar pedidos con más de 2 minutos de antigüedad
Sistema  →  Redis         : GEORADIUS(lng, lat, 15km, ASC)
Redis    →  Sistema       : [driverId_1, ...]
Sistema  →  Chofer        : [WebSocket] NEW_ORDER_RETRY(orderId, datos)
```

> **[ INSERTAR IMAGEN: dss-cu014-cron-reintento.png ]**

---

#### 🔴 DSS — CU-015: Aceptar Pedido

```
Actor: Chofer

Chofer   →  Sistema : aceptarPedido(orderId, deliveryId)
Sistema  →  Base de Datos : validarChofer(deliveryId) → isActive=true, validated=true
Sistema  →  Base de Datos : actualizarPedido(orderId, status=ACCEPTED, delivery_id, acceptedAt)
Sistema  →  Cliente : [WebSocket] order:accepted(orderId, driverName, driverPhone)
Sistema  →  Cliente : [FCM Push] "¡Tu pedido fue aceptado!"
Sistema  →  Chofer  : pedidoAsignado(orderId)
```

> **[ INSERTAR IMAGEN: dss-cu015-aceptar-pedido.png ]**

---

#### 🔴 DSS — CU-017: Actualizar Ubicación GPS del Chofer

```
Actor: Chofer (emisión periódica automática desde la app)

Chofer   →  Sistema : [WebSocket] driver:update-location(userId, lat, lng)
Sistema  →  Redis   : GEOADD(drivers:locations, lng, lat, userId)
Redis    →  Sistema : OK
```

> **[ INSERTAR IMAGEN: dss-cu017-actualizar-gps.png ]**
>
> Nota: este diagrama no tiene respuesta al actor porque es un evento fire-and-forget. El sistema solo actualiza Redis.

---

#### 🔴 DSS — CU-020: Confirmar Entrega

```
Actor: Chofer

Chofer   →  Sistema : confirmarEntrega(orderId)
Sistema  →  Base de Datos : actualizarPedido(status=DELIVERED, deliveredAt=now())
Sistema  →  Base de Datos : [si paymentMethod=CASH] actualizarPago(paymentStatus=PAID)
Sistema  →  Cliente : [WebSocket] order:delivered(orderId)
Sistema  →  Cliente : [FCM Push] "¡Pedido entregado! Gracias por tu compra."
Sistema  →  Chofer  : entregaConfirmada(orderId)
```

> **[ INSERTAR IMAGEN: dss-cu020-confirmar-entrega.png ]**

---

#### 🔴 🤖 DSS — CU-006 (interno): Reserva y Restitución de Stock

```
[Al crear pedido — CU-005]
Sistema  →  Base de Datos : BEGIN TRANSACTION
Sistema  →  Base de Datos : SELECT stock WHERE gas_cylinder_id = X FOR UPDATE
Base de Datos  →  Sistema : stockActual
Sistema  →  Sistema       : verificar stock >= cantidad solicitada
Sistema  →  Base de Datos : UPDATE stock = stock - cantidad
Sistema  →  Base de Datos : COMMIT

[Al cancelar pedido por Cliente o Admin]
Sistema  →  Base de Datos : BEGIN TRANSACTION
Sistema  →  Base de Datos : UPDATE stock = stock + cantidad (por cada ítem)
Sistema  →  Base de Datos : COMMIT
```

> **[ INSERTAR IMAGEN: dss-stock-transaccional.png ]**

---

#### 🟡 DSS — CU-023: Registrar Reclamo

```
Actor: Cliente

Cliente  →  Sistema : crearReclamo(orderId, customerId, reason, description, photoUrl?)
Sistema  →  Base de Datos : validar que order.customer_id == customerId
Sistema  →  Base de Datos : INSERT INTO claims(order_id, customer_id, reason, description, photoUrl, status=PENDING)
Sistema  →  Cliente : reclamoCreado(claimId, status="PENDING")
```

> **[ INSERTAR IMAGEN: dss-cu023-reclamo.png ]**

---

### 2.2 Contratos de Operaciones del Sistema

---

#### 🔴 Contrato: `iniciarSesion()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `iniciarSesion(email, password)` |
| **Responsabilidades** | Autenticar al usuario contra Firebase Authentication, validar su existencia y estado en la base de datos, y emitir un JWT firmado para las próximas operaciones. |
| **Tipo** | Sistema |
| **Referencias cruzadas** | CU-001, OBJ-01, OBJ-05 |
| **Precondiciones** | El usuario tiene una cuenta registrada en el sistema. El email y la contraseña son strings no vacíos. Firebase Authentication está disponible. |
| **Postcondiciones** | Si las credenciales son válidas: se generó un JWT con `{ sub: userId, role, profileId }` firmado HS256 con expiración de 7 días. El usuario recibió `{ accessToken, user }`. La sesión queda persistida del lado cliente (SecureStorage / cookie httpOnly). |
| **Excepciones** | Si Firebase rechaza las credenciales → error 401 "Credenciales inválidas". Si el `User` no existe en BD pese a tener `firebaseUid` → error 403 "Usuario no autorizado". Si `role = CHOFER` y `Delivery.validated = false` → error 403 "Cuenta pendiente de validación". |
| **Salida** | `{ accessToken: string, user: { id, email, fullName, role, profileId } }` |

---

#### 🔴 Contrato: `crearPedido()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `crearPedido(customerId, addressId, timeSlotId, items[], paymentMethod, notificationToken?)` |
| **Responsabilidades** | Crear un pedido reservando el stock de forma atómica, calcular el total con promociones y disparar el despacho automático. |
| **Tipo** | Sistema |
| **Referencias cruzadas** | CU-005, OBJ-01, OBJ-06 |
| **Precondiciones** | El cliente existe y está autenticado. Cada gasCylinderId referenciado en items[] existe y tiene stock >= cantidad solicitada. La dirección pertenece al cliente. La franja horaria existe y está activa. |
| **Postcondiciones** | Se creó una instancia de `Order` con estado PENDING. Se decrementó `GasCylinder.stock` por la cantidad de cada ítem. Se crearon instancias de `OrderItem` asociadas al pedido. Se notificaron los choferes cercanos via WebSocket. Se envió FCM push al cliente. |
| **Excepciones** | Si el stock es insuficiente → rollback total, error 400. Si el cliente no existe → error 404. Si la dirección no pertenece al cliente → error 404. |

---

#### 🔴 🤖 Contrato: `asignarPorProximidad()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `asignarPorProximidad(lat, lng, radiusKm)` |
| **Responsabilidades** | Consultar en Redis los choferes disponibles dentro del radio indicado y notificarlos por WebSocket del nuevo pedido disponible. |
| **Tipo** | Sistema (automático) |
| **Referencias cruzadas** | CU-013, CU-014, OBJ-02 |
| **Precondiciones** | Existen choferes con ubicación registrada en Redis (GEOADD). El pedido tiene estado PENDING. |
| **Postcondiciones** | Cada chofer dentro del radio recibió el evento `server:new-order-request` con los datos del pedido. El estado del pedido no cambia (permanece PENDING hasta que algún chofer acepte). |
| **Excepciones** | Si Redis no devuelve choferes → no se emiten eventos. El cron reintentará con radio 15km en la próxima ejecución. |

---

#### 🔴 Contrato: `aceptarPedido()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `aceptarPedido(orderId, deliveryId)` |
| **Responsabilidades** | Asignar el chofer al pedido, cambiar el estado a ACCEPTED y notificar al cliente. |
| **Tipo** | Sistema |
| **Referencias cruzadas** | CU-015, OBJ-02, OBJ-03 |
| **Precondiciones** | El pedido existe y tiene estado PENDING. El chofer existe, tiene `isActive = true` y `validated = true`. |
| **Postcondiciones** | Se actualizó `Order.delivery_id` con el ID del chofer. Se actualizó `Order.status` a ACCEPTED. Se registró `Order.acceptedAt`. Se emitió el evento `order:accepted` al cliente por WebSocket. Se envió FCM push al cliente. |
| **Excepciones** | Si el chofer no está activo o no está validado → error 400. Si el pedido no existe → error 404. |

---

#### 🔴 Contrato: `actualizarUbicacion()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `actualizarUbicacion(userId, lat, lng)` |
| **Responsabilidades** | Guardar la posición GPS actual del chofer en Redis para que esté disponible en el radar de asignación y en el mapa del cliente. |
| **Tipo** | Sistema |
| **Referencias cruzadas** | CU-017, OBJ-02, OBJ-03 |
| **Precondiciones** | El chofer está autenticado y conectado al WebSocket. Los valores de lat y lng son válidos. |
| **Postcondiciones** | Se ejecutó `GEOADD drivers:locations lng lat userId` en Redis. La posición del chofer está actualizada y disponible para consultas de proximidad. |
| **Excepciones** | Si lat o lng son inválidos → el evento se descarta sin error visible al usuario. |

---

#### 🔴 Contrato: `confirmarEntrega()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `confirmarEntrega(orderId)` |
| **Responsabilidades** | Cerrar el ciclo del pedido marcándolo como entregado, actualizar el estado de pago si corresponde y notificar al cliente. |
| **Tipo** | Sistema |
| **Referencias cruzadas** | CU-020, OBJ-03, OBJ-04 |
| **Precondiciones** | El pedido existe y tiene estado ON_THE_WAY. El chofer es el asignado al pedido. |
| **Postcondiciones** | Se actualizó `Order.status` a DELIVERED. Se registró `Order.deliveredAt`. Si `paymentMethod = CASH` → se actualizó `Order.paymentStatus` a PAID. Se emitió el evento `order:delivered` al cliente por WebSocket. Se envió FCM push al cliente. |
| **Excepciones** | Si el pedido ya está DELIVERED o CANCELLED → error 400 "El pedido ya está finalizado". |

---

#### 🔴 🤖 Contrato: `restituirStock()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `restituirStock(orderId)` |
| **Responsabilidades** | Devolver al stock de cada garrafa las unidades reservadas al momento de la creación del pedido cancelado. |
| **Tipo** | Sistema (automático al cancelar) |
| **Referencias cruzadas** | CU-008, CU-010, OBJ-06 |
| **Precondiciones** | El pedido tiene estado PENDING o ACCEPTED (no DELIVERED ni CANCELLED). El rol que cancela es Cliente o Administrador. |
| **Postcondiciones** | Por cada `OrderItem` del pedido: se ejecutó `UPDATE gas_cylinder SET stock = stock + item.quantity` dentro de una transacción. El pedido tiene estado CANCELLED y `cancellationReason` registrado. Se emitió el evento `order:cancelled` al cliente por WebSocket. |
| **Excepciones** | Si la transacción de restitución falla → rollback, el pedido no se cancela. |

---

#### 🟡 Contrato: `crearReclamo()`

| Campo | Detalle |
|-------|---------|
| **Nombre** | `crearReclamo(orderId, customerId, reason, description, photoUrl?)` |
| **Responsabilidades** | Registrar un reclamo del cliente sobre un pedido, validando que el pedido le pertenece. |
| **Tipo** | Sistema |
| **Referencias cruzadas** | CU-023, OBJ-04 |
| **Precondiciones** | El cliente está autenticado. El pedido existe. `Order.customer_id == customerId`. |
| **Postcondiciones** | Se creó una instancia de `Claim` con estado PENDING asociada al pedido y al cliente. |
| **Excepciones** | Si el pedido no pertenece al cliente → error 400 "No autorizado". Si el pedido no existe → error 404. |

---

## 3. Módulos Inteligentes del Sistema 🤖

Estos son los procesos que el sistema ejecuta de forma completamente autónoma, sin requerir ninguna acción del usuario.

| # | Módulo | Disparador | Qué hace solo |
|---|--------|-----------|---------------|
| 1 | **Despacho por proximidad** | Creación de un pedido (CU-005) | Consulta Redis, encuentra choferes en 5km y los notifica por WebSocket automáticamente. |
| 2 | **Cron de reintentos** | Timer automático cada 1 minuto | Busca pedidos PENDING sin chofer, amplía el radio a 15km y reintenta la notificación. |
| 3 | **Reserva atómica de stock** | Confirmación de pedido | Decrementa el stock de cada producto dentro de una transacción. Si falla algo, hace rollback total. |
| 4 | **Restitución de stock** | Cancelación de pedido | Detecta qué rol cancela y si corresponde devuelve automáticamente las unidades al inventario. |
| 5 | **Actualización de estado de pago** | Confirmación de entrega | Si el método es efectivo, marca el pago como PAID sin intervención del operador. |
| 6 | **Notificaciones WebSocket** | Cualquier cambio de estado del pedido | Emite el evento correspondiente al cliente (accepted, on-the-way, arrived, delivered, cancelled) en tiempo real. |
| 7 | **Notificaciones FCM** | Creación y cambios de estado del pedido | Envía push notification al dispositivo del cliente incluso si la app está cerrada. |
| 8 | **Limpieza del radar GPS** | Chofer se pone inactivo | Elimina la ubicación del chofer de Redis (`ZREM`) para que no reciba nuevos pedidos. |
| 9 | **Aplicación de promociones** | Cálculo del total al crear pedido | Detecta si la cantidad supera el mínimo de una promoción y aplica el descuento automáticamente con precisión decimal. |
| 10 | **Recargo por método de pago** | Cálculo del total al crear pedido | Si el cliente elige transferencia, agrega el 10% de recargo automáticamente sin que el operador intervenga. |

> Esta sección se desarrolla con mayor detalle en el **Doc 3 — Diseño**, donde cada módulo inteligente tiene su diagrama de interacción y diagrama de clases asociado.

---

## 4. Glosario

| Término | Categoría | Definición |
|---------|-----------|------------|
| **SPLG** | Acrónimo | Sistema de Pedidos y Logística de Garrafas de Gas. Nombre formal del proyecto. |
| **UP** | Metodología | Unified Process. Proceso de desarrollo iterativo e incremental adoptado por la cátedra. |
| **CU** | Artefacto UML | Caso de Uso. Descripción de una secuencia de interacciones entre un actor y el sistema para alcanzar un objetivo. |
| **Actor** | Concepto UML | Entidad externa al sistema (humano o automático) que interactúa con él para cumplir un objetivo. |
| **DSS** | Artefacto UML | Diagrama de Secuencia a nivel de Sistema. Modelo del sistema como caja negra que muestra solo los mensajes entre actor y sistema. |
| **Contrato de Operación** | Artefacto UP | Especificación formal de una operación del sistema con responsabilidades, precondiciones, postcondiciones y excepciones. |
| **Modelo Conceptual** | Artefacto UML | Diagrama de clases del dominio del problema, sin métodos, que muestra los conceptos relevantes y sus relaciones. |
| **Concepto Idóneo** | Concepto UP | Concepto del dominio que se incluye finalmente en el Modelo Conceptual por ser relevante para los CUs. |
| **JWT** | Tecnología | JSON Web Token. Token firmado usado para autenticación stateless en las APIs del backend. |
| **HS256** | Tecnología | Algoritmo de firma simétrica (HMAC + SHA-256) usado para firmar los JWT. |
| **GEORADIUS** | Tecnología | Comando de Redis que retorna miembros de un Sorted Set GEO ordenados por distancia desde un punto. |
| **GEOADD** | Tecnología | Comando de Redis que agrega un miembro con sus coordenadas geográficas a un Sorted Set GEO. |
| **WebSocket** | Tecnología | Protocolo bidireccional de comunicación en tiempo real entre cliente y servidor sobre TCP. |
| **Socket.IO** | Tecnología | Librería sobre WebSocket que agrega reconexión automática, salas y fallback HTTP polling. |
| **FCM** | Tecnología | Firebase Cloud Messaging. Servicio de Google para envío de push notifications a dispositivos Android, iOS y Web. |
| **QueryRunner** | Tecnología | API de TypeORM para ejecutar transacciones manuales sobre PostgreSQL. |
| **SELECT FOR UPDATE** | Tecnología | Sentencia SQL que adquiere un lock pesimista sobre las filas seleccionadas hasta que termina la transacción. |
| **Stock fantasma** | Concepto | Stock comprometido en una transacción no finalizada que bloquea la disponibilidad real para otros pedidos. Se previene con rollback automático. |
| **Cron** | Concepto | Tarea programada que se ejecuta a intervalos regulares. En el sistema, se usa `@Cron('* * * * *')` (cada minuto). |
| **JSONB** | Tecnología | Tipo de columna PostgreSQL para almacenar JSON binario indexable. Usado para `GasCylinder.promotions`. |
| **Soft-delete** | Concepto | Eliminación lógica que marca un registro como inactivo (`deletedAt`) sin borrarlo físicamente. |
| **Geohash** | Concepto | Codificación geográfica de coordenadas en strings cortos. Redis lo usa internamente para indexar posiciones. |
| **Pedido PENDING** | Estado | Pedido recién creado, sin chofer asignado. Esperando despacho automático o manual. |
| **Pedido ACCEPTED** | Estado | Pedido tomado por un chofer pero aún no en camino. |
| **Pedido ON_THE_WAY** | Estado | Pedido en tránsito. El chofer marca el inicio del envío. |
| **Pedido DELIVERED** | Estado | Pedido entregado. Cierra el ciclo de la transacción. |
| **Pedido CANCELLED** | Estado | Pedido cancelado por cliente, chofer o administrador. Restituye stock si correspondía. |
| **MVP** | Concepto | Minimum Viable Product. Versión mínima del sistema con las funcionalidades críticas del negocio. |
| **MVVM** | Patrón | Model-View-ViewModel. Arquitectura usada en las apps Flutter (Stacked) y Panel React. |
| **Stacked** | Tecnología | Framework MVVM para Flutter usado en las dos apps móviles del proyecto. |
| **NestJS** | Tecnología | Framework Node.js para construir APIs REST y WebSocket con TypeScript. Backend del sistema. |
| **TypeORM** | Tecnología | ORM de TypeScript usado para mapear las entities del dominio a tablas PostgreSQL. |
| **Despacho automático** | Concepto | Proceso por el cual el sistema asigna automáticamente un chofer a un pedido sin intervención humana, usando GEORADIUS. |
| **Radio expandido** | Concepto | Estrategia del cron de reintentos que amplía progresivamente el radio de búsqueda de choferes (5km → 10km → 15km) hasta encontrar candidatos. |
| **Promoción por volumen** | Concepto | Descuento aplicado automáticamente cuando la cantidad de un producto en el carrito alcanza un mínimo. |
| **Recargo por transferencia** | Concepto | Aumento del 10% al total cuando el método de pago es TRANSFER, aplicado automáticamente por el módulo M3. |
| **Validación de chofer** | Concepto | Habilitación permanente de un chofer por parte del administrador (`Delivery.validated = true`). Distinta de la disponibilidad operativa (`isActive`). |
| **FCEQyN – UNaM** | Institución | Facultad de Ciencias Exactas, Químicas y Naturales — Universidad Nacional de Misiones. Institución académica del proyecto. |
