# Auditoría Técnica — SPLG (5 Proyectos)

**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas
**Fecha:** 2026-05-14
**Autor:** Nahuel Wagner
**Alcance:** Backend (NestJS) + App Cliente (Flutter) + App Chofer (Flutter) + jennygas_lib (Dart) + Panel Admin (React)

---

## Resumen Ejecutivo Cross-Proyecto

Auditoría sobre 8 conceptos arquitectónicos en los 5 proyectos para validar robustez antes de salir a producción.

### Matriz consolidada (5 proyectos × 8 conceptos)

| # | Concepto | Backend | App Cliente | App Chofer | jennygas_lib | Panel Admin |
|---|----------|:-------:|:-----------:|:----------:|:------------:|:-----------:|
| 1 | Idempotencia | ❌ | ⚠️ | ❌ | ❌ | ⚠️ |
| 2 | Workers / Isolates | ⚠️ | ❌ | ⚠️ | ❌ | ❌ |
| 3 | Queues / Offline | ❌ | ❌ | ❌ | ❌ | ❌ |
| 4 | Base transaccional | ⚠️ | ❌ | ❌ | ❌ | ⚠️ |
| 5 | Cálculos | ✅ | 🔴 | ⚠️ | 🔴 | ⚠️ |
| 6 | Métricas / Monitoreo | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| 7 | Concurrencia | ⚠️ | ✅ | ❌ | ❌ | ⚠️ |
| 8 | Vector DB | ❌ NA | ❌ NA | ⚪ NA | ⚪ NA | ⚠️ |

**Leyenda:** ✅ Bien · ⚠️ Parcial · ❌ Faltante · 🔴 Riesgo crítico · ⚪ No aplica

### Hallazgos transversales críticos

| # | Hallazgo | Impacto |
|---|----------|---------|
| 1 | **Pricing inconsistente cross-stack** | Backend usa `decimal.js`, App Cliente usa `double` (IEEE 754), `jennygas_lib` no tiene `PricingCalculator`, Admin usa `toFixed/Math.round`. Riesgo de mostrar totales distintos en cliente vs backend. |
| 2 | **Sin idempotencia end-to-end** | Ningún proyecto envía/valida `Idempotency-Key`. Retry de red → pedido duplicado o doble cobro. |
| 3 | **Sin error tracking en ninguna app** | Ni Sentry, ni Crashlytics, ni Firebase Analytics en clientes. Si crashea en producción, no nos enteramos. |
| 4 | **App Chofer ~40% implementada** | `HomeViewModel.connect()` es TODO, `OrderInfoSheetModel` vacío, `DirectionsView` placeholder. Bloquea CU-013, CU-015, CU-017, CU-018, CU-020. |
| 5 | **jennygas_lib es solo modelos** | No tiene lógica de negocio compartida. El cálculo de pricing debería vivir acá pero está duplicado en Cliente. |
| 6 | **Sin persistencia offline en mobile** | Ninguna app Flutter usa Hive/sqflite/drift. Carrito y rutas GPS se pierden si la app cierra. |
| 7 | **Vector DB innecesario** | Ningún proyecto justifica una BD vectorial. Skip. |

### Tiempo estimado para MVP robusto

| Sprint | Foco | Días |
|--------|------|:----:|
| 1 | Bloqueadores críticos del Backend (locks, idempotencia) | 5 |
| 2 | Completar App Chofer (WebSocket + UI faltante) | 5 |
| 3 | Robustez clientes (Decimal, persistencia offline, Crashlytics) | 5 |
| 4 | Métricas + queues (BullMQ backend + Sentry todas las apps) | 5 |

**Total: ~20 días desarrollador full-time** para llevar el sistema a producción robusta.

---

## 1. Backend NestJS

**Stack auditado:** NestJS + TypeORM + PostgreSQL + Redis + Socket.IO + Firebase

### Resumen

| # | Concepto | Estado | Prioridad | Esfuerzo |
|---|----------|:------:|:---------:|:--------:|
| 1 | Idempotencia | ❌ | 🔴 CRÍTICA | 2d |
| 2 | Workers | ⚠️ | 🟠 ALTA | 3d |
| 3 | Queues | ❌ | 🟠 ALTA | 2d |
| 4 | Transacciones | ⚠️ | 🔴 CRÍTICA | 1d |
| 5 | Cálculos | ✅ | — | — |
| 6 | Métricas | ⚠️ | 🟡 MEDIA | 2d |
| 7 | Locks distribuidos | ⚠️ | 🟠 ALTA | 1d |
| 8 | Vector DB | ❌ NA | ⚪ BAJA | — |

### Hallazgos clave

**Idempotencia (❌):**
`POST /orders` y `PATCH /orders/:id/status` no validan `Idempotency-Key`. Retry de red → stock se decrementa 2 veces, dos choferes asignados al mismo pedido.

**Transacciones (⚠️):**
QueryRunner implementado pero **sin pessimistic lock** en stock. Race condition crítica: T1 y T2 leen stock, ambos creen tener disponible, ambos decrementan → oversell. Falta `setLock('pessimistic_write')` en `OrderService.create()` línea 106.

**Queues (❌):**
FCM bloqueante dentro de transacciones. Sin BullMQ, sin retry. Webhooks de MercadoPago sin garantía de entrega.

**Cron sin lock distribuido (⚠️):**
`@Cron(EVERY_MINUTE)` en `DispatchService` corre en cada pod simultáneamente → notificaciones duplicadas. Falta Redlock.

### Plan de acción

```bash
# Sprint 1 — Bloqueadores
npm install redlock @nestjs/bull bull @nestjs/terminus
```

1. Middleware de idempotencia con Redis (TTL 24h)
2. Pessimistic locks + retry de deadlocks en `create()`
3. Redlock en cron de despacho
4. Health checks `/health` con `@nestjs/terminus`

---

## 2. App Cliente Flutter

**Stack auditado:** Flutter 3.0.3+ · Stacked 3.4.0 · dio 5.9.0 · Firebase Core 4.2.0

### Resumen

| # | Concepto | Estado | Prioridad |
|---|----------|:------:|:---------:|
| 1 | Idempotencia | ⚠️ | 🔴 ALTA |
| 2 | Isolates | ❌ | 🟡 MEDIA |
| 3 | Offline Queue | ❌ | 🔴 ALTA |
| 4 | Base local | ❌ | 🔴 ALTA |
| 5 | Cálculos `$$$` | 🔴 | 🔴 **CRÍTICO** |
| 6 | Analytics | ⚠️ | 🟡 MEDIA |
| 7 | State mgmt | ✅ | 🟢 BAJA |
| 8 | Búsqueda local | ❌ | 🟢 BAJA |

### Hallazgos clave

**🔴 Cálculos con `double` (CRÍTICO):**
`checkout_viewmodel.dart` líneas 104-158 hace `item.cylinder.price * item.quantity` con `double`. Recargo 10% transferencia: `itemsTotal * 0.10`. En IEEE 754: `0.1 * 10 != 1.0`. **El cliente puede mostrar un total y el backend (que usa `decimal.js`) calcular otro distinto.**

**Idempotencia (⚠️):**
Botón "Confirmar" con `!viewModel.isBusy` protege double-tap local pero **no envía `Idempotency-Key`** al backend. Si el ViewModel se reconstruye o si hay reintento de red transparente, riesgo de pedido duplicado.

**Sin persistencia (❌):**
Carrito es `ReactiveValue<Order?>` en RAM. Si el usuario cierra la app antes de confirmar, pierde todo. Sin Hive/sqflite en `pubspec.yaml`.

**Sin Crashlytics (⚠️):**
Firebase Core inicializado pero `firebase_crashlytics` y `firebase_analytics` no están en `pubspec.yaml`. Crashes silenciosos en producción.

**State management (✅):**
Único punto bueno. `setBusy(true/false)` en `confirmOrder()`, botón disabled durante mutation. Stacked correctamente usado.

### Plan de acción

```yaml
# pubspec.yaml — agregar
decimal: ^2.1.0           # CRÍTICO: dinero
uuid: ^4.0.0              # Idempotency-Key
hive: ^2.2.0              # carrito persistente
connectivity_plus: ^6.0.0 # detectar offline
firebase_analytics: ^11.0.0
firebase_crashlytics: ^4.0.0
```

**Prioridad #1:** Reemplazar todos los cálculos monetarios `double` → `Decimal` en `checkout_viewmodel.dart`.

---

## 3. App Chofer Flutter

**Stack auditado:** Flutter + Stacked + Google Maps + Geolocator + Firebase (sin Socket.IO)

### Resumen

| # | Concepto | Estado | Prioridad |
|---|----------|:------:|:---------:|
| 1 | Idempotencia | ❌ | 🔴 ALTA |
| 2 | Background GPS | ⚠️ | 🔴 ALTA |
| 3 | Offline Queue | ❌ | 🔴 ALTA |
| 4 | Base local | ❌ | 🟡 MEDIA |
| 5 | Cálculos | ⚠️ | 🟡 MEDIA |
| 6 | Crashlytics | ❌ | 🔴 CRÍTICA |
| 7 | Concurrencia WS | ❌ | 🔴 CRÍTICA |
| 8 | Vector DB | ⚪ NA | — |

### Estado de implementación: ~40%

| Componente | Estado |
|-----------|:------:|
| `HomeViewModel.connect()` | ❌ Solo `debugPrint('Conectando chofer...')` — es TODO |
| `OrderInfoSheetModel` | ❌ Clase vacía (3 líneas) |
| `DirectionsView` | ❌ Solo `Text("DirectionsView")` placeholder |
| `DirectionsViewModel` | ❌ Vacío |
| `OrderService.fetch()` | ⚠️ Retorna mocks con `Future.delayed(Duration(seconds: 2))` |
| `LoginViewModel.onLogin()` | ⚠️ Delay 3s sin autenticar |
| `LocationService` | ⚠️ GPS funciona pero solo en foreground |
| WebSocket | ❌ Sin `socket_io_client` en `pubspec.yaml` |
| Crashlytics | ❌ Sin `firebase_crashlytics` |

### Hallazgos clave

**🔴 Bloqueo arquitectónico:**
Sin WebSocket conectado, **toda la cadena de despacho falla**:
- CU-013 Despacho automático → chofer no recibe
- CU-015 Aceptar pedido → no hay UI
- CU-017 GPS al servidor → no se envía
- CU-018 En camino → no implementado
- CU-020 Confirmar entrega → no implementado

**GPS no funciona en background (⚠️):**
`Geolocator.getPositionStream()` se detiene al minimizar la app. Falta `flutter_background_service` o `workmanager`. Para un chofer manejando, esto es inaceptable.

**Sin Crashlytics (❌ CRÍTICO):**
La app del chofer no puede crashear durante una entrega sin reportar. Requerido **antes de producción**.

### Plan de acción (orden estricto)

1. WebSocket: `socket_io_client: ^2.1.2` + completar `HomeViewModel.connect()`
2. UI completa de `OrderInfoSheet` (botones Aceptar/Rechazar) → CU-015/016
3. `DirectionsView` completo → CU-018/019/020
4. Background GPS con `flutter_background_service`
5. Crashlytics + logging estructurado
6. Hive para buffer offline de GPS

**Sprint estimado:** 5 días full-time mínimo.

---

## 4. Librería Compartida `jennygas_lib`

**Stack auditado:** Dart 3 + Freezed + json_serializable

### Resumen

| # | Concepto | Estado |
|---|----------|:------:|
| 1 | Idempotencia helpers | ❌ |
| 2 | Isolate helpers | ❌ |
| 3 | Queue interfaces | ❌ |
| 4 | DB schema compartido | ❌ |
| 5 | **Pricing centralizado** | 🔴 |
| 6 | Logger / Analytics interface | ❌ |
| 7 | State primitives | ❌ |
| 8 | Vector DB | ⚪ NA |

### Estructura actual

```
lib/
├── domain/      # 5 modelos: Order, OrderItem, Customer, GasCylinder, Address, Discount
├── theme/       # UI: colores, tipografía
└── jennygas_lib.dart  # barrel export
```

**Pubspec:** Solo `freezed` + `json_annotation`. Sin `decimal`, sin `logger`, sin `dio`. Test file vacío.

### Hallazgo crítico

🔴 **Pricing duplicado en App Cliente.**
La lib **no tiene** `PricingCalculator`. Toda la lógica de cálculo (subtotal con descuento por volumen, recargo 10% transferencia, total final) está hardcodeada en `checkout_viewmodel.dart` de la app Cliente. Cuando se implemente App Chofer (mostrar total al chofer), inevitablemente se duplicará la lógica → riesgo de divergencia.

### Plan de acción

Crear en `jennygas_lib`:

```dart
// lib/domain/pricing_calculator.dart
class PricingCalculator {
  static Decimal calculateSubtotal(OrderItem item, List<Discount> discounts);
  static Decimal applyDiscount(Decimal amount, Discount discount);
  static Decimal calculateTransferSurcharge(Decimal itemsTotal, PaymentMethod method);
  static Decimal calculateFinalTotal(List<OrderItem> items, PaymentMethod method);
}
```

Más:

- `lib/utils/idempotency.dart` — generador de keys
- `lib/utils/retry_policy.dart` — política de reintentos compartida
- `lib/services/logger.dart` — interface para Sentry/Crashlytics
- `lib/utils/offline_queue.dart` — interface `OfflineQueue`

**Agregar a pubspec:** `decimal: ^2.1.0`

---

## 5. Panel Admin React

**Stack auditado:** React 18.2 + Vite 4.4 + Redux Toolkit + React Query v4 + MUI + Recharts + react-hook-form

### Resumen

| # | Concepto | Estado | Prioridad |
|---|----------|:------:|:---------:|
| 1 | Anti-double-submit | ⚠️ | 🟡 MEDIA |
| 2 | Web Workers | ❌ | 🟢 BAJA |
| 3 | Background sync | ❌ NA | ⚪ |
| 4 | Optimistic updates | ⚠️ | 🟡 MEDIA |
| 5 | Cálculos | ⚠️ | 🟡 MEDIA |
| 6 | Sentry | ❌ | 🔴 ALTA |
| 7 | AbortController | ❌ | 🟡 MEDIA |
| 8 | Búsqueda | ⚠️ | 🟢 BAJA |

### Hallazgos clave

**Anti-double-submit (⚠️):**
Modales usan `disabled={isSaving}`. Funciona pero el modal puede cerrarse durante la mutation (sin lock preventivo en `onClose`).

**Optimistic updates (⚠️):**
Mutations esperan `onSuccess` antes de actualizar UI. Con conexiones lentas se siente laggy. React Query soporta `onMutate` con rollback, pero no se usa.

**Sin error tracking (❌):**
Cero Sentry. Si una mutation falla silenciosamente, nadie se entera. Sin error boundary en `Layout`.

**Race conditions (⚠️):**
`React.StrictMode` activo (bueno para dev) pero **sin `AbortController`** en `useTable`. Si el admin navega rápido entre páginas, fetches viejos siguen procesándose → puede pisar el state nuevo.

**Cálculos (⚠️):**
KPIs y totales 100% backend (correcto). Pero formateo en cliente con `Math.round()` y `toFixed(1)`. Sin `decimal.js`. Bajo riesgo, pero validar antes de mostrar totales agregados.

**Búsqueda (⚠️):**
Delegada 100% a backend. Sin debounce visible en algunos filtros. Si el dataset crece >10k registros, va a ser problema.

### Plan de acción

```bash
npm install @sentry/react axios-retry
```

1. Integrar Sentry + error boundary en `Layout`
2. Agregar `AbortController` a `useTable` queryFn
3. Implementar optimistic updates en mutations críticas (CRUD)
4. Validar precision monetaria en `Reports.tsx`
5. Agregar debounce a filtros de Orders/Claims

### Estado puntuación: 6.5/10

Funcional para uso interno pero frágil para producción seria.

---

## Plan de Acción Consolidado

### Sprint 1 — Bloqueadores Backend (5 días)

| Día | Tarea |
|:---:|-------|
| 1-2 | Idempotencia con Redis en Backend (`Idempotency-Key` middleware) |
| 3 | Pessimistic locks + retry deadlocks en `OrderService.create()` |
| 4 | Redlock en cron de `DispatchService` |
| 5 | Health checks `@nestjs/terminus` + smoke tests |

### Sprint 2 — Completar App Chofer (5 días)

| Día | Tarea |
|:---:|-------|
| 1 | WebSocket: `HomeViewModel.connect()` real + `socket_io_client` |
| 2 | `OrderInfoSheet`: aceptar/rechazar pedido (CU-015/016) |
| 3 | `DirectionsView`: en camino + llegada + entrega (CU-018/019/020) |
| 4 | Background GPS con `flutter_background_service` |
| 5 | Firebase Crashlytics + logging |

### Sprint 3 — Robustez Clientes (5 días)

| Día | Tarea |
|:---:|-------|
| 1 | Crear `PricingCalculator` en `jennygas_lib` con `Decimal` |
| 2 | Migrar App Cliente: `double` → `Decimal` en checkout |
| 3 | Hive para persistencia de carrito (App Cliente) |
| 4 | Crashlytics + Analytics en App Cliente |
| 5 | Sentry en Panel Admin + error boundary + AbortController |

### Sprint 4 — Métricas + Queues (5 días)

| Día | Tarea |
|:---:|-------|
| 1-2 | BullMQ en Backend: NotificationsQueue + WebhookQueue |
| 3 | OpenTelemetry básico en Backend |
| 4 | Offline queue (Hive) en App Cliente + App Chofer |
| 5 | Cache de promociones en Redis + logging de pricing |

---

## Conclusión Final

El sistema está **funcional** pero **no production-ready** sin completar al menos los Sprints 1 y 2:

- **Sprint 1 obligatorio:** Sin idempotencia + locks, el primer cliente con problema de red puede generar pedidos duplicados / desajuste de stock.
- **Sprint 2 obligatorio:** Sin App Chofer terminada, no hay forma de operar el negocio. Es la app más atrasada del proyecto.
- **Sprint 3 fuertemente recomendado:** El bug de `double` en cálculos monetarios eventualmente generará un reclamo por $X.YY mostrado en cliente vs $X.YZ cobrado.
- **Sprint 4 antes de producción seria:** Sin observabilidad, debugging de producción es a ciegas.

**Total realista para MVP robusto: 20 días desarrollador full-time.**

Vector DB queda fuera del scope. Si en Fase 3 surge necesidad de búsqueda semántica sobre reclamos o reviews, considerar `pgvector` (extensión nativa de PostgreSQL) sin agregar BD adicional.
