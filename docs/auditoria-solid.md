# Auditoría SOLID — SPLG (5 Proyectos)

**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas
**Fecha:** 2026-05-14
**Autor:** Nahuel Wagner
**Alcance:** Backend (NestJS) + App Cliente (Flutter) + App Chofer (Flutter) + jennygas_lib (Dart) + Panel Admin (React)

---

## Resumen Ejecutivo Cross-Proyecto

Auditoría de los 5 principios SOLID en los 5 proyectos. Reporte sin modificaciones de código — solo análisis.

### Matriz consolidada (5 proyectos × 5 principios)

| Principio | Backend | Cliente | Chofer | Lib | Admin |
|-----------|:-------:|:-------:|:------:|:---:|:-----:|
| **S** — SRP | 🔴 | ⚠️ | 🔴 | ⚠️ | 🔴 |
| **O** — OCP | ⚠️ | ⚠️ | 🟡 | 🔴 | 🔴 |
| **L** — LSP | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| **I** — ISP | ⚠️ | ✅ | 🔴 | ⚠️ | ⚠️ |
| **D** — DIP | 🔴 | 🔴 | 🔴 | ✅ | ⚠️ |

**Leyenda:** ✅ Bien · ⚠️ Violaciones menores · 🔴 Violaciones críticas · 🟡 Riesgo futuro

### Scoring por proyecto (sobre 10)

| Proyecto | Score | Diagnóstico |
|----------|:-----:|-------------|
| Panel Admin | 4/10 | Buena arquitectura base, alta duplicación CRUD (~30% del código) |
| Backend NestJS | 4.5/10 | Modular pero `OrderService` y `NotificationsService` muy acoplados |
| App Cliente | 5/10 | Clean Architecture en capas inferiores, **capa de presentación muy gruesa** |
| App Chofer | 3.5/10 | 40% implementada — momento ideal para diseñar bien antes de continuar |
| jennygas_lib | 6/10 | DIP impecable (no importa nada de las apps) pero le falta lógica de negocio |

---

## 7 Hallazgos Transversales Críticos

### 🔴 #1 — Pricing duplicado por TODO el stack

El cálculo de precio con descuentos por volumen y recargo del 10% por transferencia aparece en:

| Lugar | Implementación |
|-------|---------------|
| Backend `OrderService.create()` líneas 118-159 | `decimal.js`, hardcoded `1.1` para TRANSFER |
| App Cliente `checkout_viewmodel.dart` líneas 104-153 | `double`, hardcoded `0.10` |
| jennygas_lib | **No existe** `PricingCalculator` (debería estar acá) |

**Impacto:** garantizado que en algún momento el cliente muestra `$X` y el backend cobra `$Y`. Tres lugares para cambiar la regla del 10%.

**Solución:** crear `jennygas_lib/lib/domain/pricing/pricing_calculator.dart` con `Decimal`, y ambas apps + backend consumirlo. Single source of truth.

### 🔴 #2 — Acoplamiento masivo a implementaciones concretas (DIP)

**4 de 5 proyectos** importan implementaciones directamente:

| Proyecto | Acopla a |
|----------|----------|
| Backend | `firebase-admin`, `RedisService`, `DriversGateway`, `CustomersGateway` directos |
| App Cliente | `FirebaseAuth.instance`, `ApiClient()` singleton, locator registra clases concretas |
| App Chofer | `Geolocator` directo, `Dio` singleton, futuro WS será concreto a Socket.IO |
| Panel Admin | `axiosConfig` y Redux store importados directamente desde hooks |

**El único proyecto con DIP correcto es `jennygas_lib`** — irónicamente porque NO hace nada que requiera servicios. Cuando se le agreguen, hay que mantener la disciplina.

### 🔴 #3 — God objects en capa de presentación

ViewModels y páginas haciendo demasiado:

| Archivo | Líneas | Responsabilidades |
|---------|:------:|-------------------|
| Backend `OrderService` | **802** | 10+ (create, search, status, stats, cancel, notify, charts) |
| Cliente `OrderTrackingViewModel` | **784** | parsing + tracking + ETA + UI |
| Cliente `CheckoutViewModel` | 247 | 7 (address, pricing, schedule, payment, validation, persist, navigation) |
| Chofer `HomeViewModel` | 176 | 5 (GPS, mapa, permisos, navegación, WS stub) |
| Admin `Customers.tsx` | 170 | state + mutations + business + UI |

**Patrón común:** la capa inferior (entities, repositories, datasources) está bien diseñada. **La presentación absorbe responsabilidades que no le tocan.**

### 🔴 #4 — Estados de pedido y métodos de pago como switches repartidos (OCP)

Agregar un nuevo `OrderStatus` (ej: `ARRIVED`) requiere modificar:

- Backend `OrderService.updateStatus()` líneas 398-441
- Backend `OrderMapper.mapStatus()` líneas 73-88
- App Cliente `OrderTrackingViewModel._normalizeStatus()` líneas 638-653
- jennygas_lib `OrderStatus` enum + métodos `isX()`
- Admin `Orders.tsx` (probablemente)

**5+ lugares para agregar 1 estado.** Violación clásica de OCP.

**Solución:** sealed classes / strategy pattern para `OrderStatus` y `PaymentMethod`. Cada estado encapsula su comportamiento.

### 🔴 #5 — Duplicación masiva de CRUD en Panel Admin (~30% del código)

Cada entidad (Customers, Deliveries, Cars, Cylinders, Orders, Claims) copia ~500 LOC:

| Patrón duplicado | Instancias | LOC duplicados |
|------------------|:----------:|:--------------:|
| Modal CRUD | 4+ | ~1200 |
| Page CRUD | 6+ | ~900 |
| Password reset form | 2 | ~100 |
| Swal alerts | Todas | ~300 |
| useTable | 6+ | ~300 |

**Total estimado:** ~2700 LOC duplicadas. Agregar la entidad "Promociones" copia el patrón completo.

**Solución:** `GenericCRUDPage<T>` + factory de servicios API + `useCRUDPage()` hook.

### 🔴 #6 — Inexistencia de interfaces en apps Flutter (ISP)

Tanto App Cliente como App Chofer **no tienen interfaces** para sus servicios:

- `OrderService`, `LocationService`, `CartService`, `HistoryService` son **clases concretas**
- Stacked locator registra **implementaciones**, no contratos
- Testing requiere mocks complejos (no se puede sustituir limpio)

**El único proyecto que tiene `OrderRepository` interface es App Cliente** y solo en la capa de Clean Architecture (la presentación se salta esto).

### 🟢 #7 — Lo único positivo cross-proyecto

| Aspecto | Proyectos | Detalle |
|---------|-----------|---------|
| **LSP** | 4/5 | Composición sobre herencia bien aplicada |
| **DIP en jennygas_lib** | 1/5 | No importa dependencias de apps — base limpia |
| **TypeScript/Dart tipado** | 5/5 | Tipos explícitos en general |
| **Modularización por dominio** | 5/5 | Carpetas separadas por entidad |
| **App Cliente Clean Architecture inferior** | 1/5 | `OrderRepository` interface + datasources separados (modelo a seguir) |

---

## Detalle por Proyecto (resumido)

### 1. Backend NestJS

| # | Violación crítica | Archivo |
|---|-------------------|---------|
| 1 | `OrderService` con 802 líneas y 10+ responsabilidades | `src/order/order.service.ts:37-801` |
| 2 | `NotificationsService` inicializa Firebase en constructor + consultas BD | `src/notifications/notifications.service.ts:23-28` |
| 3 | Surcharge 10% hardcoded en `if (PaymentMethod.TRANSFER)` | `src/order/order.service.ts:156` |
| 4 | Inyecta `RedisService` y `Gateways` concretos (no interfaces) | `src/order/order.service.ts:34, 61-62` |

**Refactor priorizado:**
1. Extraer `PricingService` (lo que hoy son las líneas 118-140 del OrderService)
2. Crear `INotificationProvider` + `FirebaseNotificationAdapter`
3. Abstraer Redis tras `ILocationService`
4. Strategy pattern para `OrderStatusHandler`

### 2. App Cliente Flutter (5/10)

| # | Violación crítica | Archivo |
|---|-------------------|---------|
| 1 | `CheckoutViewModel` con 7 responsabilidades | `lib/ui/views/checkout/checkout_viewmodel.dart:18-265` |
| 2 | `OrderTrackingViewModel` con 784 líneas, parsing mezclado con UI | `lib/ui/views/order_tracking/order_tracking_viewmodel.dart:26-784` |
| 3 | `FirebaseAuth.instance` directo, sin abstracción | `lib/services/customer_service.dart:22` |
| 4 | `ApiClient` Singleton sin interfaz | `lib/core/network/api_client.dart:6` |
| 5 | Locator registra clases concretas | `lib/app/app.locator.dart:33-41` |

**Refactor priorizado:**
1. Extraer `PricingService` + `DeliveryScheduleService` del `CheckoutViewModel`
2. Crear `OrderDataParser` y sacar parsing de `OrderTrackingViewModel`
3. `IAuthProvider` + `IHttpClient` interfaces
4. PaymentMethodStrategy para soportar MercadoPago futuro

### 3. App Chofer Flutter (3.5/10)

| # | Violación crítica | Archivo |
|---|-------------------|---------|
| 1 | `HomeViewModel` mezcla GPS + mapa + permisos + nav + WS | `lib/ui/views/home/home_viewmodel.dart:14-176` |
| 2 | **No existen interfaces** — todo locator de clases concretas | `lib/services/*` |
| 3 | `Geolocator` directo (no detrás de `IGpsProvider`) | `lib/services/location_service.dart:5` |
| 4 | `connect()` futuro será concreto a Socket.IO | `lib/ui/views/home/home_viewmodel.dart:166-169` |

**Insight clave:** la app está al 40%, así que **el momento ideal para refactorear es AHORA** antes de implementar más. Crear `IConnectionService`, `IGpsProvider`, `IHttpClient` **antes** de escribir WebSocket evita deuda técnica.

### 4. jennygas_lib (6/10) — la mejor scoring

| # | Hallazgo | Tipo |
|---|----------|------|
| 1 | DIP impecable: no importa Firebase/dio/etc | ✅ Fortaleza |
| 2 | `Order.isPending()/etc.` mezcla datos con lógica | ⚠️ SRP menor |
| 3 | **Falta `PricingCalculator`** (crítico arquitectural) | 🔴 OCP/SRP |
| 4 | `Order` con 28 campos donde varios son null según estado | ⚠️ ISP |
| 5 | Test file vacío | ⚠️ |

**Esta lib debería ser el cerebro compartido.** Hoy es solo data transfer objects. Agregando `PricingCalculator`, `PromotionRule`, `OrderStatusTransition` resuelve 60% de los problemas cross-proyecto.

### 5. Panel Admin React (4/10)

| # | Violación crítica | Archivo |
|---|-------------------|---------|
| 1 | Pages CRUD con 4+ responsabilidades (170+ líneas cada una) | `src/pages/Customers/Customers.tsx`, `Deliveries/`, `Orders/`, etc. |
| 2 | Modales >300 líneas con form + password reset duplicado | `src/pages/Customers/components/CustomerModal.tsx:306` |
| 3 | Páginas acopladas directamente a `axiosConfig` | `src/pages/Customers/Customers.tsx:4-7` |
| 4 | React Query keys como strings mágicos repetidos | múltiples archivos |
| 5 | `useCRUDModal` mezcla 2 sistemas de notificación (Redux + Swal) | `src/hooks/useCRUDModal.ts` |

**Refactor priorizado:**
1. `GenericCRUDPage<T>` (resuelve ~30% de la duplicación)
2. Repository pattern para abstraer axios
3. `queryKeys` factory tipado
4. Hook unificado `useNotification`

---

## Plan de Refactor Cross-Proyecto (orden recomendado)

### Sprint 1 — Quick wins en jennygas_lib (3 días)

Resolver acá impacta a 3 apps simultáneamente.

| Día | Tarea |
|:---:|-------|
| 1 | Crear `PricingCalculator` con `Decimal` package en `jennygas_lib/lib/domain/pricing/` |
| 2 | Crear `PromotionRule` sealed class extensible |
| 3 | Crear `OrderStatus` como sealed class (en vez de enum); tests unitarios |

### Sprint 2 — DIP en clientes (5 días)

| Día | Tarea |
|:---:|-------|
| 1-2 | App Cliente: `IAuthProvider`, `IHttpClient`, registrar en locator |
| 3 | App Cliente: migrar `CheckoutViewModel` para usar `PricingCalculator` de la lib |
| 4-5 | App Chofer: `IGpsProvider`, `IConnectionService`, `IHttpClient` (antes del WebSocket) |

### Sprint 3 — Backend SRP + DIP (5 días)

| Día | Tarea |
|:---:|-------|
| 1-2 | Extraer `PricingService` del `OrderService` (consume `PricingCalculator` de jennygas_lib? No, esto es backend Node — replicar en TS) |
| 3 | Crear `INotificationProvider` + `FirebaseNotificationAdapter` |
| 4 | Strategy pattern para `OrderStatusHandler` y `PaymentMethodStrategy` |
| 5 | Tests con mocks limpios usando las nuevas interfaces |

### Sprint 4 — Admin generalización (4 días)

| Día | Tarea |
|:---:|-------|
| 1-2 | `GenericCRUDPage<T>` + factory de API services |
| 3 | `useCRUDPage` hook + `useNotification` unificado |
| 4 | `queryKeys` factory + migración progresiva |

**Total: ~17 días de refactor cross-proyecto para subir el scoring de 4.5/10 promedio a 7.5/10.**

---

## Conclusión

El sistema tiene **buena estructura modular en macro** (separación por dominios, Clean Architecture parcial, TypeScript/Dart tipado), pero **viola DIP y SRP de forma consistente** en la capa de presentación y servicios concretos.

**3 fixes que mueven la aguja cross-proyecto:**

1. **`PricingCalculator` en jennygas_lib** → resuelve duplicación + riesgo financiero cross-app
2. **Interfaces de dependencias externas** (Firebase, Redis, GPS, HTTP) → testabilidad + flexibilidad
3. **Generic CRUD en Admin** → reduce 30% del código duplicado

LSP está bien en general (5/5 proyectos). Es el único principio donde no hay problemas serios.

**Decisión de timing:** App Chofer está al 40% — refactorizar SUS interfaces AHORA, antes de implementar más features, evita el doble trabajo de refactor + nuevas features.
