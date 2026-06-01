# Plan del Proyecto
**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas  
**Versión:** 1.2  
**Fecha:** 2026-05-03  
**Realizado por:** Nahuel Wagner  
**Realizado para:** Distribuidor de Gas Envasado (Cliente Real)  
**Institución:** FCEQyN – UNaM  
**Metodología:** Unified Process (UP)

---

## Lista de Cambios

| Nro | Fecha | Descripción | Autor |
|-----|-------|-------------|-------|
| 0 | 2026-04-16 | Versión inicial | Nahuel Wagner |
| 1 | 2026-04-16 | Se incorporan las 2 apps móviles y se ajustan iteraciones de Construcción a 5 | Nahuel Wagner |
| 2 | 2026-05-03 | Nombre corregido a SPLG, Gantt con fechas reales, tabla de actores ampliada, CUs de alto nivel completos, tabla de calificación completa | Nahuel Wagner |

---

## 1. Componentes del Sistema

El sistema SPLG está compuesto por **4 componentes** que trabajan en conjunto:

| Componente | Tecnología | Descripción |
|------------|-----------|-------------|
| **Backend API** | NestJS (TypeScript) | Servidor principal. Gestiona toda la lógica de negocio, base de datos PostgreSQL, cache Redis, WebSockets y notificaciones push. |
| **App Cliente** | Flutter (iOS / Android) | App móvil para usuarios finales. Permite realizar pedidos, elegir franjas horarias, pagar y hacer seguimiento en tiempo real del repartidor en el mapa. |
| **App Chofer** | Flutter (Android) | App móvil para repartidores. Recibe pedidos cercanos mediante WebSocket, actualiza ubicación GPS, gestiona el estado de la entrega y confirma la recepción. |
| **Panel Administrativo** | React + Vite (Web) | Panel web para el operador del distribuidor. Gestiona choferes, vehículos, productos, stock, precios, franjas horarias, reclamos y reportes. |

---

## 2. Plan de las Fases

| Fase | Nro. Iteraciones | Duración estimada | Período |
|------|:---------------:|:----------------:|---------|
| Fase de Inicio | — | 3 semanas | Abr 2026 |
| Fase de Elaboración | 1 (E-01) | 3 semanas | Abr–May 2026 |
| Fase de Construcción | 5 (C-01 a C-05) | 15 semanas | May–Ago 2026 |
| Fase de Transición | 1 (T-01) | 6 semanas | Sep–Oct 2026 |

---

## 3. Hitos por Fase

### Fase de Inicio
- Identificación del escenario real: distribuidor de gas con operación 100% telefónica y sin trazabilidad.
- Relevamiento de necesidades con el cliente (entrevistas, observación directa).
- Identificación de actores y casos de uso principales.
- Redacción y aprobación de la Propuesta de Proyecto por la cátedra.
- Presentación del Plan del Proyecto (Doc 0).
- **Hito de cierre:** Plan del Proyecto aprobado por el docente.

### Fase de Elaboración
- Análisis en profundidad de los CU arquitectónicamente más críticos del sistema.
- Definición y validación de la arquitectura técnica: NestJS + Flutter + React + PostgreSQL + Redis + Firebase Auth.
- Producción del Modelo Conceptual preliminar del dominio.
- Prototipo de arquitectura ejecutable que valide el despacho automático con Redis GEORADIUS.
- Documentación completa de los CU priorizados (CU-001, CU-005, CU-013, CU-017, CU-020).
- **Hito de cierre:** Arquitectura validada con el cliente, prototipo funcional demostrado.

### Fase de Construcción
- **C-01:** Autenticación (Firebase Auth + JWT), roles diferenciados y estructura base del backend NestJS.
- **C-02:** Módulo de pedidos con reserva atómica de stock (QueryRunner PostgreSQL) y despacho automático por geolocalización (Redis GEOADD / GEORADIUS).
- **C-03:** Seguimiento GPS en tiempo real con WebSockets + Redis Adapter. App Chofer (Flutter) — GPS continuo y gestión de pedidos.
- **C-04:** Reclamos, reportes, dashboard con estadísticas, módulo de vehículos y notificaciones FCM. Panel Admin (React/Vite).
- **C-05:** App Cliente (Flutter) — flujo completo: catálogo, checkout, tracking en mapa y reclamos.
- **Hito de cierre:** Release 2.0 — sistema con capacidad operacional completa, listo para pruebas beta.

### Fase de Transición
- Pruebas de aceptación con usuarios reales (choferes y clientes del distribuidor).
- Corrección de defectos detectados en las pruebas beta.
- Despliegue en entorno de producción (Docker Compose, servidor on-premise del cliente).
- Entrega de documentación completa (manuales de usuario, guías de despliegue).
- **Hito de cierre:** Sistema en producción, usuarios capacitados, documentación entregada.

---

## 4. Calendario del Proyecto — Diagrama de Gantt

El cronograma se divide en **31 semanas** (S1 a S31), desde el **07/04/2026** hasta el **10/11/2026**. La siguiente tabla indica el rango de fechas y la fase de cada semana:

| Semana | Desde | Hasta | Fase |
|:---:|:---:|:---:|---|
| S1 | 07/04/2026 | 13/04/2026 | Inicio |
| S2 | 14/04/2026 | 20/04/2026 | Inicio |
| S3 | 21/04/2026 | 27/04/2026 | Inicio |
| S4 | 28/04/2026 | 04/05/2026 | Elaboración (E-01) |
| S5 | 05/05/2026 | 11/05/2026 | Elaboración (E-01) |
| S6 | 12/05/2026 | 18/05/2026 | Elaboración (E-01) |
| S7 | 19/05/2026 | 25/05/2026 | Construcción C-01 |
| S8 | 26/05/2026 | 01/06/2026 | Construcción C-01 |
| S9 | 02/06/2026 | 08/06/2026 | Construcción C-02 |
| S10 | 09/06/2026 | 15/06/2026 | Construcción C-02 |
| S11 | 16/06/2026 | 22/06/2026 | Construcción C-02 |
| S12 | 23/06/2026 | 29/06/2026 | Construcción C-03 |
| S13 | 30/06/2026 | 06/07/2026 | Construcción C-03 |
| S14 | 07/07/2026 | 13/07/2026 | Construcción C-03 |
| S15 | 14/07/2026 | 20/07/2026 | Construcción C-04 |
| S16 | 21/07/2026 | 27/07/2026 | Construcción C-04 |
| S17 | 28/07/2026 | 03/08/2026 | Construcción C-04 |
| S18 | 04/08/2026 | 10/08/2026 | Construcción C-05 (App Cliente) |
| S19 | 11/08/2026 | 17/08/2026 | Construcción C-05 (App Cliente) |
| S20 | 18/08/2026 | 24/08/2026 | Construcción C-05 (App Cliente) |
| S21 | 25/08/2026 | 31/08/2026 | Integración + Release 2.0 |
| S22 | 01/09/2026 | 07/09/2026 | Integración + Release 2.0 |
| S23 | 08/09/2026 | 14/09/2026 | Transición — Pruebas beta |
| S24 | 15/09/2026 | 21/09/2026 | Transición — Pruebas beta |
| S25 | 22/09/2026 | 28/09/2026 | Transición — Pruebas beta |
| S26 | 29/09/2026 | 05/10/2026 | Transición — Pruebas beta |
| S27 | 06/10/2026 | 12/10/2026 | Transición — Producción + cierre |
| S28 | 13/10/2026 | 19/10/2026 | Transición — Producción + cierre |
| S29 | 20/10/2026 | 26/10/2026 | Transición — Producción + cierre |
| S30 | 27/10/2026 | 02/11/2026 | Transición — Producción + cierre |
| S31 | 03/11/2026 | 10/11/2026 | Transición — Producción + cierre |

### Diagrama de Gantt por semanas

| Actividad | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 | S13 | S14 | S15 | S16 | S17 | S18 | S19 | S20 | S21 | S22 | S23 | S24 | S25 | S26 | S27 | S28 | S29 | S30 | S31 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **INICIO** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Relevamiento con el cliente | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Propuesta de Proyecto | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Plan del Proyecto (Doc 0) | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **ELABORACIÓN (E-01)** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Análisis CU críticos — Doc 1 Requisitos |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Análisis — Doc 2 Modelo Conceptual |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Prototipo de arquitectura |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **CONSTRUCCIÓN C-01** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Auth + Usuarios + Base backend |  |  |  |  |  |  | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Doc 3 Diseño — CU-001, CU-002, CU-003 |  |  |  |  |  |  | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **CONSTRUCCIÓN C-02** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Pedidos + Stock atómico + Despacho |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Doc 3 Diseño — CU-005, CU-013, CU-014 |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **CONSTRUCCIÓN C-03** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| WebSockets + Redis + App Chofer |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Doc 3 Diseño — CU-015, CU-017, CU-020 |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **CONSTRUCCIÓN C-04** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Reclamos + Reportes + Panel Admin |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Doc 3 Diseño — CU-023, CU-026 |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **CONSTRUCCIÓN C-05** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| App Cliente (Flutter) completa |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ |  |  |  |  |  |  |  |  |  |  |  |
| Integración final y Release 2.0 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ |  |  |  |  |  |  |  |  |  |
| **TRANSICIÓN (T-01)** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Pruebas de aceptación (usuarios reales) |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ | ██ |  |  |  |  |  |
| Corrección de defectos beta |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ | ██ |  |  |  |  |  |
| Despliegue en producción |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ | ██ | ██ |
| Manuales y documentación final |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ██ | ██ | ██ | ██ | ██ |

> **Período total:** **07/04/2026 – 10/11/2026** (31 semanas, ~8 meses). Cada iteración de Construcción dura aproximadamente 3 semanas.

---

## 5. Actores del Sistema

| Código | Actor | Tipo | Descripción |
|--------|-------|:----:|-------------|
| ACT-01 | **Cliente** | Humano | Usuario final que instala la App Cliente (Flutter) en su celular. Realiza pedidos de garrafas, elige franja horaria, selecciona método de pago, sigue el pedido en tiempo real en el mapa y puede registrar reclamos post-entrega. |
| ACT-02 | **Chofer / Repartidor** | Humano | Repartidor del distribuidor que utiliza la App Chofer (Flutter) en su dispositivo Android. Recibe notificaciones de pedidos cercanos por WebSocket, acepta o rechaza pedidos, actualiza su posición GPS en tiempo real y confirma la entrega al cliente. |
| ACT-03 | **Administrador** | Humano | Operador interno del distribuidor. Accede al Panel Web (React/Vite) para gestionar choferes, vehículos, productos, stock, precios, franjas horarias, reclamos y visualizar reportes y el dashboard operativo. Tiene acceso total al sistema. |
| ACT-04 | **Sistema (Automático)** | Sistema | Proceso interno del backend que opera sin intervención humana. Ejecuta el despacho automático por geolocalización (CU-013), el cron de reintentos con radio expandido (CU-014), la reserva atómica de stock, las notificaciones automáticas y los módulos inteligentes M1 a M5. No tiene interfaz de usuario. |

### Descripción Ampliada de Actores

**ACT-01 — Cliente:**
Persona que contrata el servicio de entrega de garrafas. Perfil tecnológico variado (usuarios con conocimientos básicos de smartphones). Accede al sistema únicamente desde la App Cliente Flutter. Sus principales necesidades son: realizar pedidos rápidamente, conocer el estado en tiempo real y poder reclamar si algo sale mal.

**ACT-02 — Chofer / Repartidor:**
Empleado del distribuidor que ejecuta las entregas físicas. Trabaja principalmente en horario de 9 a 21 hs. Maneja la App Chofer en un dispositivo Android provisto por el distribuidor. Su principal necesidad es recibir pedidos de forma ordenada, conocer la ruta y confirmar entregas de manera simple.

**ACT-03 — Administrador:**
Operador de oficina del distribuidor. Puede ser una o más personas. Accede al Panel Web desde una PC o notebook con conexión a internet. Sus principales necesidades son: visibilidad completa del estado operativo, control de inventario y reportes de ventas para la toma de decisiones.

**ACT-04 — Sistema (Automático):**
No es un actor humano sino un conjunto de procesos internos del backend NestJS que se ejecutan de forma automática ante determinados eventos o en intervalos de tiempo programados. Incluye el `DispatchService` con su cron job, el `OrderService` con la transacción atómica, los gateways WebSocket y el servicio de notificaciones FCM.

---

## 6. Diagrama de Casos de Uso del Sistema

> **[ INSERTAR IMAGEN: diagrama-cu-sistema.png ]**  
> *Recomendado: usar el código PlantUML de `GUIA-diagramas-cu-plantuml.md` §2 (incluye relaciones `«include»`/`«extend»`). Alternativa manual con draw.io en la Sección 9 de este documento.*

---

## 7. Casos de Uso de Alto Nivel

> Para el listado completo de los 45 CU, ver el documento `CU-APP-DELIVERY.md`.

---

**Código:** CU-001 | **Caso de Uso:** Iniciar Sesión  
**Actor/es:** Cliente (ACT-01), Chofer (ACT-02), Administrador (ACT-03)  
**Subsistema:** SS-01 Autenticación y Usuarios  
**Calificación:** Crítico  
**Descripción:** El usuario ingresa sus credenciales (email y contraseña) en la app correspondiente. El sistema verifica la identidad contra Firebase Auth, genera un JWT propio con el rol del usuario (CLIENTE, CHOFER o ADMIN) en el payload y lo retorna. Ese token habilita el acceso a las funcionalidades permitidas para ese rol. El chofer recién registrado no puede acceder hasta ser validado por el administrador.

---

**Código:** CU-002 | **Caso de Uso:** Registrarse como Cliente  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-01 Autenticación y Usuarios  
**Calificación:** Crítico  
**Descripción:** Un nuevo usuario descarga la App Cliente y completa el formulario de registro con nombre completo, email, teléfono y contraseña. El sistema crea la cuenta en Firebase Auth y registra el perfil en la base de datos con rol CLIENTE. Al finalizar, el usuario queda autenticado automáticamente y puede comenzar a realizar pedidos.

---

**Código:** CU-003 | **Caso de Uso:** Registrar Chofer  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-01 Autenticación y Usuarios  
**Calificación:** Crítico  
**Descripción:** El administrador crea un nuevo usuario chofer desde el panel web, ingresando nombre, email, teléfono y contraseña temporal. El chofer queda en estado "no validado" y no puede recibir pedidos hasta que el administrador ejecute la validación explícita (CU-032).

---

**Código:** CU-004 | **Caso de Uso:** Gestionar Perfil de Usuario  
**Actor/es:** Cliente (ACT-01), Chofer (ACT-02)  
**Subsistema:** SS-01 Autenticación y Usuarios  
**Calificación:** Importante  
**Descripción:** El usuario actualiza su información personal desde la app: nombre completo y número de teléfono. Los cambios se persisten en la base de datos y se reflejan inmediatamente en las apps y en el panel del administrador.

---

**Código:** CU-005 | **Caso de Uso:** Crear Pedido  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Crítico  
**Descripción:** El cliente selecciona uno o más productos del catálogo, especifica la cantidad, elige una dirección de entrega guardada o selecciona una en el mapa, elige una franja horaria disponible y selecciona el método de pago (efectivo, MercadoPago o transferencia con recargo del 10%). El sistema verifica el stock, reserva las unidades de forma atómica en una transacción PostgreSQL, calcula el total con promociones y recargos, registra el pedido con estado PENDING y dispara automáticamente la búsqueda del chofer más cercano (CU-013).

---

**Código:** CU-006 | **Caso de Uso:** Consultar Detalle de Pedido  
**Actor/es:** Cliente (ACT-01), Chofer (ACT-02), Administrador (ACT-03)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Crítico  
**Descripción:** El usuario accede al detalle completo de un pedido específico: ítems y cantidades, precios, descuentos aplicados, estado actual, datos del chofer asignado, dirección de entrega, franja horaria, método de pago y timestamps de cada cambio de estado (creado, aceptado, en camino, entregado/cancelado).

---

**Código:** CU-007 | **Caso de Uso:** Consultar Historial de Pedidos  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Importante  
**Descripción:** El cliente accede al listado de todos sus pedidos anteriores ordenados por fecha descendente. Puede filtrar por estado. Cada ítem del listado muestra el resumen del pedido (fecha, total, estado) con acceso al detalle completo.

---

**Código:** CU-008 | **Caso de Uso:** Cancelar Pedido (Cliente)  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Importante  
**Descripción:** El cliente cancela un pedido que aún no fue despachado (estado PENDING o ACCEPTED). El sistema valida que sea posible cancelar, cambia el estado a CANCELLED, restituye automáticamente el stock de cada ítem al inventario dentro de una transacción, y notifica al chofer asignado (si lo hay) por WebSocket.

---

**Código:** CU-009 | **Caso de Uso:** Cancelar Pedido (Chofer)  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Importante  
**Descripción:** El chofer que ya aceptó un pedido decide no poder realizarlo. El sistema cambia el estado del pedido de ACCEPTED de vuelta a PENDING (no cancela definitivamente) para que otro chofer pueda aceptarlo. El stock no se restituye porque el pedido sigue activo.

---

**Código:** CU-010 | **Caso de Uso:** Cancelar Pedido (Administrador)  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Importante  
**Descripción:** El administrador puede cancelar cualquier pedido activo (en cualquier estado previo a DELIVERED) desde el panel web, indicando obligatoriamente un motivo. El sistema marca el pedido como CANCELLED, restituye el stock y notifica tanto al cliente como al chofer asignado.

---

**Código:** CU-011 | **Caso de Uso:** Listar Todos los Pedidos  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Importante  
**Descripción:** El administrador visualiza en el panel web todos los pedidos del sistema con paginación. Puede filtrar por estado (PENDING, ACCEPTED, ON_THE_WAY, DELIVERED, CANCELLED), por fecha y por chofer asignado. Cada registro muestra el resumen del pedido con acceso al detalle.

---

**Código:** CU-012 | **Caso de Uso:** Asignar Chofer Manualmente  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-03 Despacho y Asignación  
**Calificación:** Secundario  
**Descripción:** Cuando el despacho automático no logra asignar un chofer (estado SIN_COBERTURA), el administrador puede seleccionar manualmente un chofer disponible y asignarlo al pedido desde el panel web.

---

**Código:** CU-013 | **Caso de Uso:** Asignar Pedido Automáticamente por Proximidad  
**Actor/es:** Sistema (ACT-04)  
**Subsistema:** SS-03 Despacho y Asignación  
**Calificación:** Crítico  
**Descripción:** Inmediatamente al crearse un pedido (disparado por CU-005), el sistema consulta en Redis con el comando GEORADIUS los choferes activos y validados dentro de un radio inicial de 5 km del domicilio de entrega, ordenados por distancia ascendente. Notifica a cada chofer elegible por WebSocket con los datos del pedido. El primer chofer que acepte ejecuta CU-015. Si ninguno acepta, el proceso CU-014 reintenta con radio expandido.

---

**Código:** CU-014 | **Caso de Uso:** Reintentar Asignación con Radio Expandido (Cron)  
**Actor/es:** Sistema (ACT-04)  
**Subsistema:** SS-03 Despacho y Asignación  
**Calificación:** Crítico  
**Descripción:** Un proceso cron automático que se ejecuta cada 1 minuto busca pedidos en estado PENDING sin chofer asignado y con más de 2 minutos de antigüedad. Para cada uno, reintenta la búsqueda de choferes con un radio progresivamente mayor: 5 km (intentos 0–2), 10 km (intentos 3–4), 15 km (intentos 5–7). Si supera 8 intentos sin resultado, marca el pedido como SIN_COBERTURA y alerta al administrador.

---

**Código:** CU-015 | **Caso de Uso:** Aceptar Pedido  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-03 Despacho y Asignación  
**Calificación:** Crítico  
**Descripción:** El chofer recibe en su app la notificación del nuevo pedido (por WebSocket) y decide aceptarlo. El sistema valida que el chofer esté activo y validado, lo asigna al pedido (estado ACCEPTED), registra el timestamp y notifica al cliente tanto por WebSocket como por FCM push con los datos del repartidor asignado (nombre, teléfono).

---

**Código:** CU-016 | **Caso de Uso:** Rechazar / Ignorar Pedido  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-03 Despacho y Asignación  
**Calificación:** Importante  
**Descripción:** El chofer que recibió la notificación de un pedido decide no aceptarlo. El sistema registra el rechazo para ese chofer y el pedido permanece disponible para otros choferes en el radio. El rechazo no afecta el estado del pedido ni el stock.

---

**Código:** CU-017 | **Caso de Uso:** Actualizar Ubicación GPS del Chofer  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-04 Seguimiento en Tiempo Real  
**Calificación:** Crítico  
**Descripción:** La App Chofer envía periódicamente (cada vez que el GPS detecta un desplazamiento de 10 metros) la posición geográfica al servidor por WebSocket (evento `driver:update-location`). El sistema ejecuta GEOADD en Redis, manteniendo la ubicación disponible tanto para el algoritmo de asignación (CU-013) como para el mapa en tiempo real de la App Cliente.

---

**Código:** CU-018 | **Caso de Uso:** Marcar Pedido "En Camino"  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-04 Seguimiento en Tiempo Real  
**Calificación:** Crítico  
**Descripción:** El chofer indica que salió del depósito hacia el domicilio del cliente. El sistema actualiza el estado del pedido a ON_THE_WAY, registra el timestamp `onTheWayAt`, emite el evento `order:on-the-way` al cliente por WebSocket y envía un push FCM con el mensaje "¡Tu pedido está en camino!".

---

**Código:** CU-019 | **Caso de Uso:** Avisar Llegada al Cliente  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-04 Seguimiento en Tiempo Real  
**Calificación:** Importante  
**Descripción:** El chofer llega al domicilio del cliente y presiona "Llegué" en la app. El sistema emite inmediatamente el evento `order:arrived` por WebSocket al cliente. La App Cliente muestra la notificación "¡El repartidor está afuera!". El estado del pedido no cambia.

---

**Código:** CU-020 | **Caso de Uso:** Confirmar Entrega  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-04 Seguimiento en Tiempo Real  
**Calificación:** Crítico  
**Descripción:** El chofer entrega el producto y presiona "Confirmar entrega". El sistema cambia el estado a DELIVERED, registra `deliveredAt`, actualiza el estado de pago a PAID si el método es efectivo, emite `order:delivered` al cliente por WebSocket y envía un FCM push de agradecimiento. El ciclo del pedido queda cerrado.

---

**Código:** CU-021 | **Caso de Uso:** Recibir Notificaciones en Tiempo Real  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-04 Seguimiento en Tiempo Real  
**Calificación:** Crítico  
**Descripción:** El cliente recibe notificaciones automáticas en tiempo real ante cada evento del pedido: confirmación de creación, asignación de chofer, "en camino", llegada del repartidor y entrega confirmada. Si la app está abierta, llegan por WebSocket; si está cerrada, por FCM push notification.

---

**Código:** CU-022 | **Caso de Uso:** Activar / Desactivar Disponibilidad (Chofer)  
**Actor/es:** Chofer (ACT-02)  
**Subsistema:** SS-04 Seguimiento en Tiempo Real  
**Calificación:** Crítico  
**Descripción:** El chofer activa o desactiva su disponibilidad para recibir pedidos mediante un toggle en la app. Al desactivarse, el sistema ejecuta ZREM en Redis para eliminar su ubicación del radar de asignación. Al activarse, el sistema registra su posición actual con GEOADD.

---

**Código:** CU-023 | **Caso de Uso:** Registrar Reclamo  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-05 Reclamos  
**Calificación:** Importante  
**Descripción:** El cliente registra un reclamo sobre un pedido entregado indicando el motivo (ej: "Fuga de gas", "Garrafa incorrecta"), una descripción detallada y opcionalmente adjunta una foto como evidencia. El sistema valida que el pedido pertenezca al cliente y crea el reclamo con estado PENDING, notificando al administrador.

---

**Código:** CU-024 | **Caso de Uso:** Listar Reclamos  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-05 Reclamos  
**Calificación:** Importante  
**Descripción:** El administrador visualiza en el panel web todos los reclamos del sistema, ordenados por fecha descendente, con posibilidad de filtrar por estado (PENDING, IN_PROCESS, RESOLVED, REJECTED). Cada registro muestra el cliente, el pedido asociado, el motivo y el estado actual.

---

**Código:** CU-025 | **Caso de Uso:** Resolver Reclamo  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-05 Reclamos  
**Calificación:** Importante  
**Descripción:** El administrador cambia el estado de un reclamo a RESOLVED o REJECTED, ingresando obligatoriamente una nota de resolución que explique la decisión tomada. El cliente recibe una notificación informando la resolución de su reclamo.

---

**Código:** CU-026 | **Caso de Uso:** Ver Dashboard General  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-06 Reportes y Dashboard  
**Calificación:** Importante  
**Descripción:** El administrador visualiza en el panel web el estado operativo en tiempo real: cantidad de pedidos por estado (PENDING, ACCEPTED, ON_THE_WAY, DELIVERED), total de ventas del día / semana / mes, cantidad de choferes activos en este momento, valor promedio de pedido y gráfico de ventas de los últimos 7 días.

---

**Código:** CU-027 | **Caso de Uso:** Ver Reporte de Ventas por Chofer  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-06 Reportes y Dashboard  
**Calificación:** Importante  
**Descripción:** El administrador consulta el total de pedidos entregados y el monto vendido por cada chofer en un rango de fechas configurable. El reporte se puede ordenar por cantidad de pedidos o por monto total.

---

**Código:** CU-028 | **Caso de Uso:** Ver Reporte de Ventas por Producto  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-06 Reportes y Dashboard  
**Calificación:** Importante  
**Descripción:** El administrador consulta la cantidad de unidades vendidas y el monto total por tipo de garrafa (10kg, 15kg, 45kg) en un rango de fechas configurable. Permite identificar qué producto tiene mayor demanda.

---

**Código:** CU-029 | **Caso de Uso:** Ver Reporte por Método de Pago  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-06 Reportes y Dashboard  
**Calificación:** Secundario  
**Descripción:** El administrador consulta la distribución de pedidos y montos por método de pago (efectivo, MercadoPago, transferencia bancaria) en un rango de fechas, para analizar el comportamiento de pago de sus clientes.

---

**Código:** CU-030 | **Caso de Uso:** Ver Gráfico de Ventas (últimos 7 días)  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-06 Reportes y Dashboard  
**Calificación:** Secundario  
**Descripción:** Dentro del Dashboard, el administrador visualiza un gráfico de barras con el monto total de ventas de cada uno de los últimos 7 días. Los días sin ventas muestran barra en cero (no se omiten).

---

**Código:** CU-032 | **Caso de Uso:** Validar / Invalidar Chofer  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-07 Gestión de Choferes y Vehículos  
**Calificación:** Crítico  
**Descripción:** El administrador habilita o deshabilita la operación de un chofer cambiando el flag `validated`. Un chofer con `validated = false` no puede aceptar pedidos ni aparecer en el radar de asignación. Esta operación es diferente de activar/desactivar disponibilidad (CU-033).

---

**Código:** CU-033 | **Caso de Uso:** Activar / Desactivar Chofer (Admin)  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-07 Gestión de Choferes y Vehículos  
**Calificación:** Importante  
**Descripción:** El administrador puede activar o desactivar un chofer desde el panel web independientemente de la disponibilidad que el chofer declare desde su app. Útil para suspender temporalmente a un chofer sin revocar su validación.

---

**Código:** CU-034 | **Caso de Uso:** Registrar Vehículo del Chofer  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-07 Gestión de Choferes y Vehículos  
**Calificación:** Importante  
**Descripción:** El administrador registra el vehículo del chofer indicando tipo (auto, moto, camioneta), patente, marca, modelo, año, color y capacidad de carga. El vehículo queda asociado al usuario del chofer. Un chofer puede tener múltiples vehículos registrados.

---

**Código:** CU-035 | **Caso de Uso:** Consultar Listado de Choferes  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-07 Gestión de Choferes y Vehículos  
**Calificación:** Importante  
**Descripción:** El administrador visualiza el listado completo de choferes registrados en el sistema con su estado (activo/inactivo, validado/no validado), datos de contacto y vehículo asignado.

---

**Código:** CU-036 | **Caso de Uso:** Crear Producto (Garrafa)  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-08 Gestión de Productos e Inventario  
**Calificación:** Crítico  
**Descripción:** El administrador registra un tipo de garrafa con tipo (ej: "10kg"), peso, precio de venta, stock inicial y descripción opcional. El producto queda activo y disponible en el catálogo de la App Cliente. Opcionalmente puede configurar promociones por volumen en el mismo formulario.

---

**Código:** CU-037 | **Caso de Uso:** Actualizar Precio de Producto  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-08 Gestión de Productos e Inventario  
**Calificación:** Crítico  
**Descripción:** El administrador modifica el precio de venta de un producto. El cambio aplica únicamente a los pedidos futuros; los pedidos ya existentes mantienen el precio al que fueron creados (almacenado en `OrderItem.unitPrice`).

---

**Código:** CU-038 | **Caso de Uso:** Actualizar Stock de Producto  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-08 Gestión de Productos e Inventario  
**Calificación:** Crítico  
**Descripción:** El administrador ajusta manualmente el stock disponible de un producto para reflejar una reposición de inventario o una corrección. El sistema actualiza el valor de `GasCylinder.stock` directamente.

---

**Código:** CU-039 | **Caso de Uso:** Configurar Promociones por Cantidad  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-08 Gestión de Productos e Inventario  
**Calificación:** Importante  
**Descripción:** El administrador define descuentos automáticos por volumen para un producto: cantidad mínima de unidades y porcentaje de descuento a aplicar. Las promociones se almacenan como JSONB en el producto y se aplican automáticamente al calcular el total de un pedido.

---

**Código:** CU-040 | **Caso de Uso:** Activar / Desactivar Producto  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-08 Gestión de Productos e Inventario  
**Calificación:** Importante  
**Descripción:** El administrador puede activar o desactivar un producto del catálogo. Un producto desactivado no aparece en la App Cliente y no puede ser pedido. Esta operación es reversible y no elimina el historial de pedidos asociados al producto.

---

**Código:** CU-041 | **Caso de Uso:** Consultar Catálogo de Productos  
**Actor/es:** Cliente (ACT-01), Administrador (ACT-03)  
**Subsistema:** SS-08 Gestión de Productos e Inventario  
**Calificación:** Crítico  
**Descripción:** El cliente visualiza en la App el catálogo de garrafas disponibles (solo productos activos con stock > 0) con precio, tipo, descripción y posibles descuentos por volumen. El administrador visualiza el catálogo completo (activos e inactivos) con el stock actual de cada uno.

---

**Código:** CU-042 | **Caso de Uso:** Crear Franja Horaria  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-09 Franjas Horarias  
**Calificación:** Importante  
**Descripción:** El administrador crea una franja horaria de entrega con nombre (ej: "Mañana"), hora de inicio (ej: 09:00), hora de fin (ej: 13:00) y capacidad máxima diaria de pedidos. La franja queda activa y disponible para selección al crear pedidos.

---

**Código:** CU-043 | **Caso de Uso:** Modificar Capacidad de Franja Horaria  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-09 Franjas Horarias  
**Calificación:** Importante  
**Descripción:** El administrador modifica la capacidad máxima diaria de pedidos de una franja horaria existente. El cambio aplica desde el día siguiente para no afectar los pedidos ya agendados para el día en curso.

---

**Código:** CU-044 | **Caso de Uso:** Seleccionar Franja Horaria al Crear Pedido  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-09 Franjas Horarias  
**Calificación:** Importante  
**Descripción:** Durante la creación de un pedido, el cliente elige la franja horaria de entrega (mañana o tarde) para la fecha solicitada. El sistema muestra solo las franjas que tienen capacidad disponible para la fecha elegida.

---

**Código:** CU-045 | **Caso de Uso:** Consultar Franjas Horarias Disponibles  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-09 Franjas Horarias  
**Calificación:** Importante  
**Descripción:** El cliente puede consultar qué franjas horarias están disponibles para una fecha específica antes de confirmar su pedido. El sistema devuelve las franjas activas con capacidad remanente para esa fecha.

---

**Código:** CU-046 | **Caso de Uso:** Gestionar Direcciones de Entrega  
**Actor/es:** Cliente (ACT-01)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Importante  
**Descripción:** El cliente administra sus direcciones de entrega desde la app: crea nuevas direcciones (con coordenadas seleccionadas en el mapa), edita o elimina las existentes, consulta su listado y marca una como predeterminada. La dirección predeterminada se precarga al crear un pedido (CU-005).

---

**Código:** CU-047 | **Caso de Uso:** Recuperar Contraseña  
**Actor/es:** Cliente (ACT-01), Chofer (ACT-02), Administrador (ACT-03)  
**Subsistema:** SS-01 Autenticación y Usuarios  
**Calificación:** Importante  
**Descripción:** Un usuario que olvidó su contraseña solicita el restablecimiento ingresando su email. El sistema envía un correo (vía Resend) con las instrucciones de recuperación. El usuario define una nueva contraseña y recupera el acceso al sistema.

---

**Código:** CU-048 | **Caso de Uso:** Procesar Pago con MercadoPago  
**Actor/es:** Sistema Automático (ACT-04)  
**Subsistema:** SS-02 Gestión de Pedidos  
**Calificación:** Crítico  
**Descripción:** Cuando un pedido se paga con MercadoPago, la pasarela notifica al backend mediante un webhook. El sistema consulta el estado real del pago, y actualiza el estado de pago del pedido (PENDING → PAID o rechazado) de forma idempotente. Complementa a CU-005, donde el cliente solo selecciona el método de pago.

---

**Código:** CU-049 | **Caso de Uso:** Consultar Balance / Ganancias del Chofer  
**Actor/es:** Chofer (ACT-02), Administrador (ACT-03)  
**Subsistema:** SS-07 Gestión de Choferes y Vehículos  
**Calificación:** Importante  
**Descripción:** El chofer consulta su balance acumulado de ganancias por entregas realizadas desde su app. El administrador puede consultar y ajustar el balance de cada chofer desde el panel. El sistema mantiene el saldo asociado al chofer y lo actualiza al confirmar entregas.

---

**Código:** CU-050 | **Caso de Uso:** Bloquear / Desbloquear Usuario  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-01 Autenticación y Usuarios  
**Calificación:** Secundario  
**Descripción:** El administrador bloquea o desbloquea a un usuario (cliente o chofer) desde el panel web por motivos de moderación o seguridad. Un usuario bloqueado no puede iniciar sesión ni operar en el sistema hasta ser desbloqueado.

---

**Código:** CU-051 | **Caso de Uso:** Gestionar Vehículos (editar / eliminar / consultar)  
**Actor/es:** Administrador (ACT-03)  
**Subsistema:** SS-07 Gestión de Choferes y Vehículos  
**Calificación:** Importante  
**Descripción:** Complementa a CU-034 (Registrar Vehículo). El administrador edita los datos de un vehículo, lo elimina, consulta el listado completo o busca un vehículo por patente. El sistema mantiene la relación vehículo–chofer.

---

## 8. Calificación de los Casos de Uso

| Caso de Uso | Subsistema | Actor Principal | Calificación |
|-------------|------------|-----------------|:------------:|
| CU-001 Iniciar Sesión | SS-01 | ACT-01, ACT-02, ACT-03 | Crítico |
| CU-002 Registrarse como Cliente | SS-01 | ACT-01 | Crítico |
| CU-003 Registrar Chofer | SS-01 | ACT-03 | Crítico |
| CU-004 Gestionar Perfil de Usuario | SS-01 | ACT-01, ACT-02 | Importante |
| CU-005 Crear Pedido | SS-02 | ACT-01 | Crítico |
| CU-006 Consultar Detalle de Pedido | SS-02 | ACT-01, ACT-02, ACT-03 | Crítico |
| CU-007 Consultar Historial de Pedidos | SS-02 | ACT-01 | Importante |
| CU-008 Cancelar Pedido (Cliente) | SS-02 | ACT-01 | Importante |
| CU-009 Cancelar Pedido (Chofer) | SS-02 | ACT-02 | Importante |
| CU-010 Cancelar Pedido (Administrador) | SS-02 | ACT-03 | Importante |
| CU-011 Listar Todos los Pedidos | SS-02 | ACT-03 | Importante |
| CU-012 Asignar Chofer Manualmente | SS-03 | ACT-03 | Secundario |
| CU-013 Asignar Pedido Automáticamente por Proximidad | SS-03 | ACT-04 | Crítico |
| CU-014 Reintentar Asignación con Radio Expandido (Cron) | SS-03 | ACT-04 | Crítico |
| CU-015 Aceptar Pedido | SS-03 | ACT-02 | Crítico |
| CU-016 Rechazar / Ignorar Pedido | SS-03 | ACT-02 | Importante |
| CU-017 Actualizar Ubicación GPS del Chofer | SS-04 | ACT-02 | Crítico |
| CU-018 Marcar Pedido "En Camino" | SS-04 | ACT-02 | Crítico |
| CU-019 Avisar Llegada al Cliente | SS-04 | ACT-02 | Importante |
| CU-020 Confirmar Entrega | SS-04 | ACT-02 | Crítico |
| CU-021 Recibir Notificaciones en Tiempo Real | SS-04 | ACT-01 | Crítico |
| CU-022 Activar / Desactivar Disponibilidad | SS-04 | ACT-02 | Crítico |
| CU-023 Registrar Reclamo | SS-05 | ACT-01 | Importante |
| CU-024 Listar Reclamos | SS-05 | ACT-03 | Importante |
| CU-025 Resolver Reclamo | SS-05 | ACT-03 | Importante |
| CU-026 Ver Dashboard General | SS-06 | ACT-03 | Importante |
| CU-027 Ver Reporte de Ventas por Chofer | SS-06 | ACT-03 | Importante |
| CU-028 Ver Reporte de Ventas por Producto | SS-06 | ACT-03 | Importante |
| CU-029 Ver Reporte por Método de Pago | SS-06 | ACT-03 | Secundario |
| CU-030 Ver Gráfico de Ventas (últimos 7 días) | SS-06 | ACT-03 | Secundario |
| CU-032 Validar / Invalidar Chofer | SS-07 | ACT-03 | Crítico |
| CU-033 Activar / Desactivar Chofer (Admin) | SS-07 | ACT-03 | Importante |
| CU-034 Registrar Vehículo del Chofer | SS-07 | ACT-03 | Importante |
| CU-035 Consultar Listado de Choferes | SS-07 | ACT-03 | Importante |
| CU-036 Crear Producto (Garrafa) | SS-08 | ACT-03 | Crítico |
| CU-037 Actualizar Precio de Producto | SS-08 | ACT-03 | Crítico |
| CU-038 Actualizar Stock de Producto | SS-08 | ACT-03 | Crítico |
| CU-039 Configurar Promociones por Cantidad | SS-08 | ACT-03 | Importante |
| CU-040 Activar / Desactivar Producto | SS-08 | ACT-03 | Importante |
| CU-041 Consultar Catálogo de Productos | SS-08 | ACT-01, ACT-03 | Crítico |
| CU-042 Crear Franja Horaria | SS-09 | ACT-03 | Importante |
| CU-043 Modificar Capacidad de Franja Horaria | SS-09 | ACT-03 | Importante |
| CU-044 Seleccionar Franja Horaria al Crear Pedido | SS-09 | ACT-01 | Importante |
| CU-045 Consultar Franjas Horarias Disponibles | SS-09 | ACT-01 | Importante |
| CU-046 Gestionar Direcciones de Entrega | SS-02 | ACT-01 | Importante |
| CU-047 Recuperar Contraseña | SS-01 | ACT-01, ACT-02, ACT-03 | Importante |
| CU-048 Procesar Pago con MercadoPago | SS-02 | ACT-04 | Crítico |
| CU-049 Consultar Balance / Ganancias del Chofer | SS-07 | ACT-02, ACT-03 | Importante |
| CU-050 Bloquear / Desbloquear Usuario | SS-01 | ACT-03 | Secundario |
| CU-051 Gestionar Vehículos (editar / eliminar / consultar) | SS-07 | ACT-03 | Importante |

### Resumen de Calificación

| Calificación | Cantidad | CU |
|:------------:|:--------:|-----|
| **Crítico** | 19 | CU-001, CU-002, CU-003, CU-005, CU-006, CU-013, CU-014, CU-015, CU-017, CU-018, CU-020, CU-021, CU-022, CU-032, CU-036, CU-037, CU-038, CU-041, CU-048 |
| **Importante** | 27 | CU-004, CU-007, CU-008, CU-009, CU-010, CU-011, CU-016, CU-019, CU-023, CU-024, CU-025, CU-026, CU-027, CU-028, CU-033, CU-034, CU-035, CU-039, CU-040, CU-042, CU-043, CU-044, CU-045, CU-046, CU-047, CU-049, CU-051 |
| **Secundario** | 4 | CU-012, CU-029, CU-030, CU-050 |

---

## 9. Guía para Construir el Diagrama de Casos de Uso (draw.io)

### Herramienta recomendada
**app.diagrams.net** (draw.io) — gratuito, online, exporta PNG/SVG.

### Paso 1 — Configurar el canvas
- Abrir draw.io → Nuevo Diagrama → En blanco.
- Menú **Archivo → Configuración de Página**: tamaño **A3**, orientación **horizontal**.

### Paso 2 — Dibujar el límite del sistema
- Insertar un **rectángulo grande** que ocupe el centro del canvas.
- Texto dentro (arriba): `«system» SPLG – Sistema de Pedidos y Logística de Garrafas de Gas`
- Sin relleno, solo borde. Tamaño aproximado: 1400 x 900 px.

### Paso 3 — Agregar los actores (fuera del rectángulo)
Usar la forma **UML Actor** (búscala en el panel lateral → UML → Actor, o usa un stick figure manual):

| Actor | Posición |
|-------|----------|
| `Cliente (ACT-01)` | Lado izquierdo, arriba |
| `Chofer (ACT-02)` | Lado izquierdo, abajo |
| `Administrador (ACT-03)` | Lado derecho, centro |
| `Sistema (ACT-04)` | Abajo, centro |

### Paso 4 — Agregar los Casos de Uso (dentro del rectángulo)
Usar la forma **Ellipse** con texto. Agrupar visualmente por color de fondo:

| Color | Subsistema | CU a incluir |
|-------|-----------|--------------|
| Azul claro | SS-01 Auth | CU-001, CU-002, CU-003 |
| Verde claro | SS-02 Pedidos | CU-005, CU-006, CU-007, CU-008 |
| Naranja claro | SS-03 Despacho | CU-013, CU-014, CU-015 |
| Amarillo claro | SS-04 Tracking | CU-017, CU-018, CU-019, CU-020, CU-021, CU-022 |
| Rojo claro | SS-05 Reclamos | CU-023, CU-024, CU-025 |
| Violeta claro | SS-06 Reportes | CU-026, CU-027, CU-028 |
| Gris claro | SS-07 Choferes | CU-032, CU-033, CU-034 |
| Marrón claro | SS-08 Productos | CU-036, CU-037, CU-038, CU-039, CU-041 |
| Celeste claro | SS-09 Franjas | CU-042, CU-043, CU-044, CU-045 |

> Tip: no incluyas todos los CU o el diagrama queda ilegible. Incluí los **Críticos** e **Importantes**. Los Secundarios los podés omitir o agrupar.

### Paso 5 — Trazar las asociaciones (líneas)

Trazar líneas simples (sin flecha o con flecha simple) entre cada actor y sus CU:

**Cliente (ACT-01) → sus CU:**
CU-001, CU-002, CU-005, CU-006, CU-007, CU-008, CU-021, CU-023, CU-041, CU-044, CU-045

**Chofer (ACT-02) → sus CU:**
CU-001, CU-015, CU-016, CU-017, CU-018, CU-019, CU-020, CU-022

**Administrador (ACT-03) → sus CU:**
CU-001, CU-003, CU-010, CU-011, CU-012, CU-024, CU-025, CU-026, CU-027, CU-028, CU-029, CU-030, CU-031, CU-032, CU-033, CU-034, CU-035, CU-036, CU-037, CU-038, CU-039, CU-040, CU-042, CU-043

**Sistema Automático (ACT-04) → sus CU:**
Agregar un actor con estereotipo `«sistema»` y conectarlo a:
CU-013, CU-014

### Paso 6 — Exportar
- Menú **Archivo → Exportar como → PNG** (resolución 200 dpi mínimo).
- Guardar como `diagrama-cu-sistema.png` en la carpeta `docs/`.
- Insertar la imagen en este documento en la Sección 6.
