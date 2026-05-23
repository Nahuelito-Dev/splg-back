# Propuesta de Proyecto — Delivery Gas

Posadas (Misiones), DD de MM de 2026

Al Prof. Adjunto de las cátedras
Trabajo Final (ASC) | Proyecto Software (LSI)
FCEQyN - UNaM
Lic. Sergio Daniel Caballero
S/D

De mi mayor consideración:

Me dirijo a Ud. a efectos de presentar la propuesta para el desarrollo de un producto software como tema para las cátedras "Proyecto Software" de la carrera Licenciatura en Sistemas de Información (plan de estudios 2013) y "Trabajo Final" de la carrera Analista en Sistemas de Computación (plan de estudios 2010).

El producto software a desarrollar se denomina: **Sistema de Pedidos y Logística para Distribuidores de Gas Envasado (Delivery Gas)**.

Sin otro particular, y quedando a la espera de la evaluación de la propuesta, me despido atte.

\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
Nahuel Wagner
LU N°: [completar]
DNI: [completar]

---

## Reservado para el equipo de cátedra

### Evaluación de la propuesta

| Aspecto | Evaluación |
|---------|------------|
| Presentación en general | |
| Objetivos | |
| Requisitos funcionales | |
| Requisitos no funcionales | |
| Procesos automáticos | 1. |
| | 2. |
| | 3. |
| Planificación | |
| Estrategia de validación / verificación | |
| Metodología | |

**Resultado final:** APROBADO — DEBE CORREGIR

Firma por el equipo de cátedra:

---

## Contenidos

1. Planteo del problema
2. Introducción y objetivos
3. Alcance y limitaciones
4. Especificación de módulos
5. Descripción de los módulos
6. Procesos automatizados
7. Estimación de tamaño por módulo
8. Entorno tecnológico y metodológico
9. Planificación de actividades

---

## 1. Planteo del Problema

- **Gestión analógica de pedidos:** Los clientes realizan pedidos exclusivamente por teléfono. No existe un canal digital de autogestión.
- **Sin trazabilidad de entregas:** El operador coordina verbalmente con los choferes. No hay registro del estado de cada entrega ni evidencia de su cumplimiento.
- **Control de stock manual:** El inventario se descuenta al final del día en planillas. Esto genera inconsistencias frecuentes entre el stock real y el registrado, y no previene ventas sin producto disponible.
- **Asignación ineficiente de choferes:** El operador asigna pedidos a choferes de forma manual sin conocer su ubicación en tiempo real, lo que genera demoras y recorridos innecesarios.
- **Reclamos sin evidencia:** Cuando un cliente reclama por entrega incorrecta o faltante, no existe registro objetivo (foto, GPS, timestamp) que permita resolver la disputa.
- **Sin visibilidad operativa:** El administrador no cuenta con métricas de desempeño por chofer, reporte de ventas por producto ni historial de pedidos accesible en tiempo real.

---

## 2. Introducción y Objetivos

El escenario en donde se desarrolla el proyecto es un distribuidor de gas envasado que opera con una flota de choferes propios realizando entregas a domicilio de garrafas de distintos tamaños (10kg, 15kg y 45kg), atendiendo a clientes residenciales y comerciales. Actualmente toda la operación se gestiona de forma analógica: pedidos por teléfono, coordinación verbal con choferes y control de stock en planillas.

**Objetivos a cubrir:**

- Desarrollar una **aplicación móvil para clientes** (Android/iOS) que permita realizar pedidos de garrafas de forma autónoma, seleccionando producto, cantidad, dirección de entrega, franja horaria y método de pago.
- Desarrollar una **aplicación móvil para choferes** (Android/iOS) que les permita recibir pedidos asignados, actualizar su ubicación GPS en tiempo real y confirmar entregas con evidencia fotográfica.
- Desarrollar un **panel web administrativo** para que el operador del distribuidor gestione choferes, productos, stock, precios, franjas horarias, reclamos y consulte reportes de ventas.
- Implementar un **algoritmo de despacho automático** que asigne cada pedido al chofer disponible más cercano al domicilio de entrega sin intervención manual.
- Integrar **seguimiento en tiempo real** para que el cliente pueda ver la ubicación del chofer en un mapa mientras su pedido está en camino.

---

## 3. Alcance y Limitaciones

El sistema cubierto por esta especificación abarca una aplicación móvil para clientes, una aplicación móvil para choferes y un panel web administrativo para el distribuidor (operador). En esta Fase 1, el producto está diseñado para un único distribuidor de garrafas de gas, gestionando todo el ciclo de vida de los pedidos desde que el cliente los realiza hasta la entrega y posibles reclamos posteriores.

Las principales capacidades incluidas en el alcance son:

- Realización de pedidos de garrafas de gas por parte de clientes a través de la app móvil, con reserva automática de stock.
- Asignación automática de pedidos a choferes disponibles en función de la proximidad al destino de entrega y confirmación de aceptación por parte del chofer.
- Seguimiento de entregas en tiempo real, con capacidad de los choferes para actualizar el estado de cada entrega, incluyendo registro fotográfico y geolocalización del punto de entrega.
- Gestión administrativa mediante un panel web: seguimiento y gestión de pedidos, administración de choferes y vehículos, actualización de precios de productos, configuración de franjas horarias de entrega y atención de reclamos de clientes.
- Reportes operativos para análisis del negocio: ventas por producto, desempeño por chofer y utilización por vehículo.

Quedan fuera del alcance de Fase 1 algunas funcionalidades previstas para fases posteriores, como el soporte a múltiples distribuidores, manejo avanzado de zonas de cobertura, opciones de entrega con prioridad paga, y módulos de facturación entre distribuidores (ver Backlog de Fase 2). Estas funcionalidades futuras se mencionan para contexto pero no serán implementadas en Fase 1.

Esta primera versión del proyecto no contempla:

- Integración con sistemas de facturación electrónica (AFIP/ARCA).
- Gestión de múltiples distribuidores (multi-tenancy) — el sistema opera para un único distribuidor.
- Optimización de rutas con múltiples paradas por viaje.
- Integración con proveedores de GLP para reposición automática de stock.
- Soporte para pagos con tarjeta de crédito/débito (solo efectivo, MercadoPago y transferencia bancaria).

---

## 4. Especificación de Módulos

### Funcionales

- Módulo de Pedidos
- Módulo de Catálogo y Stock
- Módulo de Despacho y Asignación
- Módulo de Seguimiento en Tiempo Real
- Módulo de Reclamos
- Módulo de Pagos
- Módulo de Franjas Horarias

### No Funcionales

- Módulo de Usuarios y Autenticación
- Módulo de Notificaciones
- Módulo de Reportes y Dashboard
- Módulo de Gestión de Choferes y Vehículos
- Módulo de Auditoría y Logs

---

## 5. Descripción de los Módulos

**Módulo de Catálogo y Stock:**
Permite registrar, modificar y activar/desactivar los productos disponibles (garrafas por tipo y peso). Cada producto cuenta con precio, stock actual y promociones por volumen configurables. El stock se descuenta automáticamente al confirmar un pedido y se restituye si el pedido es cancelado.

**Módulo de Pedidos:**
Permite al cliente crear un pedido seleccionando productos, cantidad, dirección de entrega (desde mapa o lista guardada), franja horaria y método de pago. El sistema valida el stock disponible, calcula el total con descuentos y recargos aplicables, y registra el pedido con su ciclo de vida completo de estados: PENDIENTE → ACEPTADO → EN CAMINO → ENTREGADO / CANCELADO.

**Módulo de Despacho y Asignación:**
Al crearse un pedido, el sistema busca automáticamente el chofer disponible más cercano usando geolocalización en tiempo real (Redis GEORADIUS). Notifica al chofer por WebSocket. Si ningún chofer acepta, un proceso automático reintenta la asignación cada minuto ampliando el radio de búsqueda hasta 15 km.

**Módulo de Seguimiento en Tiempo Real:**
La App Chofer transmite la posición GPS al servidor continuamente. El cliente puede ver la ubicación del repartidor en un mapa en tiempo real y recibe notificaciones automáticas ante cada cambio de estado del pedido (aceptado, en camino, entregado).

**Módulo de Reclamos:**
El cliente puede registrar un reclamo sobre un pedido entregado, con descripción y foto opcional como evidencia. El administrador gestiona los reclamos desde el panel web, pudiendo resolverlos o rechazarlos con una nota de resolución.

**Módulo de Pagos:**
Registra el método de pago de cada pedido: efectivo, MercadoPago o transferencia bancaria. Aplica automáticamente un recargo del 10% para pagos por transferencia. El administrador puede consultar el historial de pagos y reportes por método de pago.

**Módulo de Franjas Horarias:**
El administrador configura las franjas horarias disponibles para entregas (ej: Mañana 9–13 hs, Tarde 17–21 hs) con una capacidad máxima diaria. El sistema bloquea automáticamente una franja cuando alcanza su límite de pedidos, evitando sobredemanda.

**Módulo de Usuarios y Autenticación:**
Gestiona los tres tipos de usuario del sistema: Cliente (app móvil), Chofer (app móvil) y Administrador (panel web). Cada rol tiene acceso únicamente a las funcionalidades que le corresponden. Un chofer no puede operar hasta ser validado por el administrador.

**Módulo de Notificaciones:**
Envía alertas automáticas por push (Firebase Cloud Messaging) y email (Resend) ante eventos del sistema: confirmación de pedido, asignación de chofer, cambios de estado y resolución de reclamos.

**Módulo de Reportes y Dashboard:**
Provee al administrador estadísticas operativas en tiempo real: pedidos por estado, ventas del día/semana/mes, choferes activos, valor promedio de pedido y gráfico de los últimos 7 días. Incluye reportes de ventas por chofer, por producto y por método de pago con filtro de rango de fechas.

**Módulo de Gestión de Choferes y Vehículos:**
Permite registrar choferes con sus datos personales y el vehículo asociado (tipo, patente, marca, modelo, año, color, capacidad). El administrador puede activar, desactivar o validar choferes según corresponda.

---

## 6. Procesos Automatizados

| Denominación | Módulos que intervienen | Descripción del proceso |
|---|---|---|
| **M1 · Despacho automático por proximidad** | Pedidos, Despacho, Seguimiento | Al crearse un pedido, el sistema busca automáticamente en Redis (GEORADIUS) los choferes disponibles dentro de un radio configurable. Notifica al más cercano por WebSocket. Si no hay respuesta dentro del tiempo de espera configurado, el pedido queda pendiente para reintento (M2). El radio inicial y el tiempo máximo de espera son configurables desde el panel administrativo. |
| **M2 · Reintento de asignación con radio expandido** | Despacho, Notificaciones | Si ningún chofer acepta dentro del tiempo configurado, un proceso automático reintenta la asignación expandiendo el radio de búsqueda en pasos configurables. El número de pasos, el incremento de radio por paso, el intervalo entre intentos y la cantidad máxima de reintentos son configurables. Al agotar los intentos, el sistema alerta al administrador por push y/o email según su preferencia, para que pueda intervenir manualmente. |
| **M3 · Control automático de stock con alertas y bloqueo** | Catálogo y Stock, Pedidos, Notificaciones | Más allá del descuento transaccional de stock por pedido, el sistema monitorea continuamente los niveles de stock de cada producto. Cuando el stock de un producto cae por debajo de un umbral mínimo configurable (individual por producto), el sistema ejecuta automáticamente: (1) notifica al administrador por push y/o email con un informe de los productos afectados y una estimación de reposición calculada en base al promedio de ventas de los últimos días; (2) opcionalmente bloquea nuevos pedidos para ese producto según configuración. El administrador decide si y cuánto reponer. Parámetros configurables: stock mínimo por producto, acción al alcanzar el mínimo (notificar / bloquear / ambos), frecuencia máxima de alertas por producto, canal de notificación, ventana de días para calcular el promedio de demanda. |
| **M4 · Alerta proactiva por demora en entrega** | Pedidos, Seguimiento, Notificaciones | Un proceso en segundo plano monitorea todos los pedidos en estado "en camino". Si un pedido supera un umbral de tiempo configurable sin ser marcado como entregado, el sistema actúa en dos niveles: (1) al superar el primer umbral, notifica al cliente que hay una demora y alerta al administrador con la ubicación del chofer y los datos del pedido; (2) al superar un segundo umbral de escalado, genera una alerta urgente al administrador. El administrador decide cómo intervenir (contactar al chofer, reasignar, compensar al cliente). Parámetros configurables: umbral de demora normal, umbral de escalado urgente, canal de notificación al cliente (push / silencioso), canal de alerta al administrador (push, email o ambos), activación/desactivación del módulo. |
| **M5 · Integración de pagos con MercadoPago** | Pagos, Pedidos, Notificaciones | Integración con la API de MercadoPago para habilitar el cobro digital mediante tarjeta de débito, crédito y QR, en complemento con los métodos de efectivo y transferencia bancaria. Al confirmar un pedido con pago digital, el sistema genera automáticamente una preferencia de pago a través de la API de MP y devuelve el enlace o QR al cliente. MercadoPago notifica al backend mediante webhook cuando el pago es aprobado, rechazado o expirado: si es aprobado, el sistema avanza el pedido al flujo de despacho; si falla o expira, cancela el pedido y restituye el stock automáticamente. El administrador configura y habilita los métodos de pago desde el panel sin intervención técnica. Parámetros configurables: credenciales MP (public key, access token), métodos habilitados (efectivo / transferencia / débito / crédito / QR), recargo por transferencia bancaria (% configurable), tiempo de expiración del enlace de pago, activación/desactivación individual de cada método. |

---

## 7. Estimación de Tamaño por Módulo

La estimación refleja la complejidad relativa de cada módulo considerando backend, apps móviles y panel web. Se indica el estado de avance actual del componente backend, que es el más desarrollado del sistema.

| Módulo | Participación | Estado backend |
|--------|:------------:|:--------------:|
| Módulo de Pedidos (creación, estados, cancelación) | 20% | ✅ Implementado |
| Módulo de Despacho y Asignación (GEORADIUS + Cron) | 18% | ✅ Implementado |
| Módulo de Seguimiento en Tiempo Real (WebSocket + GPS) | 15% | ✅ Backend / 🔧 App Chofer parcial |
| Módulo de Usuarios y Autenticación (JWT + Firebase + roles) | 10% | ✅ Implementado |
| Módulo de Catálogo y Stock (garrafas, promociones, reserva atómica) | 10% | ✅ Implementado |
| Módulo de Reportes y Dashboard (ventas, estadísticas, gráficos) | 10% | ✅ Implementado |
| Módulo de Gestión de Choferes y Vehículos | 7% | ✅ Implementado |
| Módulo de Reclamos (registro, resolución, foto) | 5% | ✅ Implementado |
| Módulo de Pagos (efectivo, MercadoPago, transferencia +10%) | 3% | ✅ Implementado |
| Módulo de Notificaciones (FCM push + email) | 1% | ✅ Implementado |
| Módulo de Franjas Horarias (capacidad diaria, bloqueo automático) | 1% | ✅ Implementado |
| **Total** | **100%** | |

> El backend se encuentra con el MVP implementado en su totalidad. El desarrollo pendiente corresponde a las apps móviles (App Chofer: integración WebSocket) y el panel administrativo (páginas de gestión y reportes).

---

## 8. Entorno Tecnológico y Metodológico

| Aspecto | Tecnología |
|---------|-----------|
| **Lenguajes de programación** | TypeScript (backend y panel web), Dart (apps móviles) |
| **Frameworks** | NestJS (backend), Flutter (apps móviles), React (panel web) |
| **Arquitectura** | Cliente–Servidor / API REST + WebSocket |
| **Motor de base de datos** | PostgreSQL (datos relacionales), Redis (geolocalización en tiempo real) |
| **Servicios externos** | Firebase Auth (autenticación), Firebase Cloud Messaging (notificaciones push), Google Maps (mapas y GPS), Resend (emails) |
| **Infraestructura** | Docker + Docker Compose (contenedores), deployable on-premise |
| **Metodología seleccionada** | UP (Unified Process) |
| **Tipo de proyecto** | Con cliente final |

---

## 9. Planificación de Actividades

| Actividad | Fecha de inicio | Fecha de finalización |
|-----------|:--------------:|:--------------------:|
| Relevamiento con el cliente y análisis de requisitos | DD/MM/AAAA | DD/MM/AAAA |
| Documentación UP — Plan del Proyecto (Doc 0) | DD/MM/AAAA | DD/MM/AAAA |
| Documentación UP — Requisitos (Doc 1) | DD/MM/AAAA | DD/MM/AAAA |
| Documentación UP — Análisis (Doc 2) | DD/MM/AAAA | DD/MM/AAAA |
| Documentación UP — Diseño (Doc 3) | DD/MM/AAAA | DD/MM/AAAA |
| Iteración C-01: Autenticación y usuarios | DD/MM/AAAA | DD/MM/AAAA |
| Iteración C-02: Pedidos, stock y despacho automático | DD/MM/AAAA | DD/MM/AAAA |
| Iteración C-03: WebSockets, GPS y App Chofer | DD/MM/AAAA | DD/MM/AAAA |
| Iteración C-04: Reclamos, reportes y Panel Admin | DD/MM/AAAA | DD/MM/AAAA |
| Iteración C-05: App Cliente completa | DD/MM/AAAA | DD/MM/AAAA |
| Pruebas de aceptación con usuarios reales | DD/MM/AAAA | DD/MM/AAAA |
| Despliegue en producción y entrega final | DD/MM/AAAA | DD/MM/AAAA |
