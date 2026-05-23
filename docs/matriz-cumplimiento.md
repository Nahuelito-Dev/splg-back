# Matriz de Cumplimiento — SPLG
**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas  
**Versión:** 1.0  
**Fecha:** 2026-05-07  
**Autor:** Nahuel Wagner  
**Institución:** FCEQyN – UNaM  

---

## Leyenda

| Símbolo | Significado |
|:-------:|-------------|
| ✅ | Implementado y funcional |
| 🔶 | Parcialmente implementado |
| ❌ | No implementado |
| ⚠️ | Requiere verificación |
| — | No aplica a este componente |

---

## Matriz de Cumplimiento por CU — Estado del Código

### SS-01 — Autenticación y Usuarios

| CU | Nombre | Calificación | Backend | App Cliente | App Chofer | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----------:|:----------:|:-----:|:-------------:|
| CU-001 | Iniciar Sesión | 🔴 Crítico | ✅ | ✅ Firebase | 🔶 Form sin API real | ✅ | 🔶 PARCIAL |
| CU-002 | Registrarse como Cliente | 🔴 Crítico | ✅ | ✅ | — | — | ✅ COMPLETO |
| CU-003 | Registrarse como Chofer | 🔴 Crítico | ✅ | — | — | ✅ Modal | ✅ COMPLETO |
| CU-004 | Gestionar Perfil de Usuario | 🟡 Importante | ✅ | 🔶 Solo lectura | ❌ | — | 🔶 PARCIAL |

### SS-02 — Gestión de Pedidos

| CU | Nombre | Calificación | Backend | App Cliente | App Chofer | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----------:|:----------:|:-----:|:-------------:|
| CU-005 | Crear Pedido | 🔴 Crítico | ✅ | ✅ Checkout completo | — | — | ✅ COMPLETO |
| CU-006 | Consultar Detalle de Pedido | 🔴 Crítico | ✅ | ✅ Tracking view | ❌ | ✅ Modal | 🔶 PARCIAL |
| CU-007 | Consultar Historial de Pedidos | 🟡 Importante | ✅ | ✅ History widget | ❌ | — | 🔶 PARCIAL |
| CU-008 | Cancelar Pedido (Cliente) | 🟡 Importante | ✅ | ✅ Desde tracking | — | — | ✅ COMPLETO |
| CU-009 | Cancelar Pedido (Chofer) | 🟡 Importante | ✅ endpoint | — | ❌ Sin UI | — | ❌ FALTANTE |
| CU-010 | Cancelar Pedido (Administrador) | 🟡 Importante | ✅ | — | — | ✅ | ✅ COMPLETO |
| CU-011 | Listar Todos los Pedidos | 🟡 Importante | ✅ | — | — | ✅ Tabla filtrable | ✅ COMPLETO |
| CU-012 | Asignar Chofer Manualmente | ⚪ Secundario | ✅ | — | — | ✅ Modal | ✅ COMPLETO |

### SS-03 — Despacho y Asignación

| CU | Nombre | Calificación | Backend | App Chofer | Estado Global |
|----|--------|:------------:|:-------:|:----------:|:-------------:|
| CU-013 | Asignar Pedido Automáticamente por Proximidad | 🔴 Crítico | ✅ Redis GEORADIUS + WS | ❌ No recibe pedidos | 🔶 PARCIAL |
| CU-014 | Reintentar Asignación con Radio Expandido (Cron) | 🔴 Crítico | ⚠️ No verificado en código | — | ⚠️ VERIFICAR |
| CU-015 | Aceptar Pedido | 🔴 Crítico | ✅ endpoint | ❌ OrderInfoSheet vacío | ❌ FALTANTE |
| CU-016 | Rechazar / Ignorar Pedido | 🟡 Importante | ✅ endpoint | ❌ Sin UI | ❌ FALTANTE |

### SS-04 — Seguimiento en Tiempo Real

| CU | Nombre | Calificación | Backend | App Cliente | App Chofer | Estado Global |
|----|--------|:------------:|:-------:|:-----------:|:----------:|:-------------:|
| CU-017 | Actualizar Ubicación GPS del Chofer | 🔴 Crítico | ✅ WS + Redis GEOADD | ✅ Recibe en mapa | 🔶 GPS local, no envía al server | 🔶 PARCIAL |
| CU-018 | Marcar Pedido "En Camino" | 🔴 Crítico | ✅ endpoint | ✅ Stepper | ❌ DirectionsView vacío | ❌ FALTANTE |
| CU-019 | Avisar Llegada al Cliente | 🟡 Importante | ✅ endpoint `/arrived` | — | ❌ Sin UI | ❌ FALTANTE |
| CU-020 | Confirmar Entrega | 🔴 Crítico | ✅ endpoint | ✅ Stepper | ❌ Sin implementar | ❌ FALTANTE |
| CU-021 | Recibir Notificaciones en Tiempo Real | 🔴 Crítico | ✅ WS + FCM | 🔶 WS OK, FCM falta | ❌ FCM importado sin lógica | 🔶 PARCIAL |
| CU-022 | Activar / Desactivar Disponibilidad | 🔴 Crítico | ✅ endpoint | — | ❌ Botón es TODO | ❌ FALTANTE |

### SS-05 — Reclamos

| CU | Nombre | Calificación | Backend | App Cliente | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----------:|:-----:|:-------------:|
| CU-023 | Registrar Reclamo | 🟡 Importante | ✅ | ❌ Sin UI | — | 🔶 PARCIAL |
| CU-024 | Listar Reclamos | 🟡 Importante | ✅ | — | ✅ Claims page | ✅ COMPLETO |
| CU-025 | Resolver Reclamo | 🟡 Importante | ✅ | — | ✅ Modal | ✅ COMPLETO |

### SS-06 — Reportes y Dashboard

| CU | Nombre | Calificación | Backend | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----:|:-------------:|
| CU-026 | Ver Dashboard General | 🟡 Importante | ✅ stats API | ✅ KPIs + widgets | ✅ COMPLETO |
| CU-027 | Ver Reporte de Ventas por Chofer | 🟡 Importante | ✅ | ✅ Reports page | ✅ COMPLETO |
| CU-028 | Ver Reporte de Ventas por Producto | 🟡 Importante | ✅ | ✅ Reports page | ✅ COMPLETO |
| CU-029 | Ver Reporte por Método de Pago | ⚪ Secundario | ✅ | ✅ Reports page | ✅ COMPLETO |
| CU-030 | Ver Gráfico de Ventas (últimos 7 días) | ⚪ Secundario | ✅ chart API | ✅ Recharts/Chart.js | ✅ COMPLETO |

### SS-07 — Gestión de Choferes y Vehículos

| CU | Nombre | Calificación | Backend | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----:|:-------------:|
| CU-031 | Registrar Chofer | 🔴 Crítico | ✅ | ✅ Modal | ✅ COMPLETO |
| CU-032 | Validar / Invalidar Chofer | 🔴 Crítico | ✅ | ✅ Acciones en tabla | ✅ COMPLETO |
| CU-033 | Activar / Desactivar Chofer (Admin) | 🟡 Importante | ✅ | ✅ | ✅ COMPLETO |
| CU-034 | Registrar Vehículo del Chofer | 🟡 Importante | ✅ | ✅ Cars + CarsManager | ✅ COMPLETO |
| CU-035 | Consultar Listado de Choferes | 🟡 Importante | ✅ | ✅ Tabla | ✅ COMPLETO |

### SS-08 — Gestión de Productos e Inventario

| CU | Nombre | Calificación | Backend | App Cliente | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----------:|:-----:|:-------------:|
| CU-036 | Crear Producto (Garrafa) | 🔴 Crítico | ✅ | — | ✅ Modal | ✅ COMPLETO |
| CU-037 | Actualizar Precio de Producto | 🔴 Crítico | ✅ | — | ✅ | ✅ COMPLETO |
| CU-038 | Actualizar Stock de Producto | 🔴 Crítico | ✅ | — | ✅ | ✅ COMPLETO |
| CU-039 | Configurar Promociones por Cantidad | 🟡 Importante | ✅ | ✅ Descuentos en checkout | ✅ PromotionsManager | ✅ COMPLETO |
| CU-040 | Activar / Desactivar Producto | 🟡 Importante | ✅ | — | ✅ | ✅ COMPLETO |
| CU-041 | Consultar Catálogo de Productos | 🔴 Crítico | ✅ | ✅ Lista productos | ✅ | ✅ COMPLETO |

### SS-09 — Franjas Horarias

| CU | Nombre | Calificación | Backend | App Cliente | Admin | Estado Global |
|----|--------|:------------:|:-------:|:-----------:|:-----:|:-------------:|
| CU-042 | Crear Franja Horaria | 🟡 Importante | ✅ | — | ✅ TimeSlotsManager | ✅ COMPLETO |
| CU-043 | Modificar Capacidad de Franja Horaria | 🟡 Importante | ✅ | — | ✅ | ✅ COMPLETO |
| CU-044 | Seleccionar Franja Horaria al Crear Pedido | 🟡 Importante | — | ✅ Checkout | — | ✅ COMPLETO |
| CU-045 | Consultar Franjas Horarias Disponibles | 🟡 Importante | ✅ | ✅ CheckoutViewModel | — | ✅ COMPLETO |

---

## Resumen de Cumplimiento

| Estado | CUs | Cantidad |
|--------|-----|:--------:|
| ✅ Completo | CU-002, 003, 005, 008, 010, 011, 012, 024, 025, 026, 027, 028, 029, 030, 031, 032, 033, 034, 035, 036, 037, 038, 039, 040, 041, 042, 043, 044, 045 | **29 / 45** |
| 🔶 Parcial | CU-001, 004, 006, 007, 013, 017, 021, 023 | **8 / 45** |
| ❌ Faltante | CU-009, 015, 016, 018, 019, 020, 022 | **7 / 45** |
| ⚠️ Verificar | CU-014 | **1 / 45** |

**Cobertura total:** 29 completos + 8 parciales = **37 / 45 CUs cubiertos al menos parcialmente (82%)**

---

## Estado de los 5 CU Priorizados para Elaboración

Estos son los CUs arquitectónicamente más significativos según la cátedra (Doc 2 §2.1 + Doc 3 §4).

| CU | Nombre | Estado en Código | Bloqueante |
|----|--------|:----------------:|------------|
| **CU-001** | Iniciar Sesión | 🔶 Parcial | App Chofer sin autenticar contra API real |
| **CU-005** | Crear Pedido | ✅ **Completo** | — |
| **CU-013** | Despacho Automático por Proximidad | 🔶 Parcial | Backend listo; App Chofer no recibe pedidos por WS |
| **CU-017** | Actualizar Ubicación GPS del Chofer | 🔶 Parcial | GPS captura localmente pero no envía al servidor WS |
| **CU-020** | Confirmar Entrega | ❌ **Faltante** | App Chofer sin implementar el flujo completo |

**1 de 5 CU priorizados completamente implementado.**

---

## Plan de Desarrollo — App Chofer (prioridad)

Los 7 CUs faltantes y los 3 CUs parciales de la App Chofer concentran toda la deuda de desarrollo.

| Orden | CU | Feature | Complejidad |
|:-----:|----|---------|:-----------:|
| 1 | CU-001 | Conectar login al backend real (Firebase Auth → JWT) | Baja |
| 2 | CU-022 | Implementar toggle disponibilidad (1 endpoint, 1 switch) | Baja |
| 3 | CU-017 | Enviar ubicación GPS por WebSocket al servidor | Media |
| 4 | CU-013 | Conectar WebSocket y recibir pedido entrante | Media |
| 5 | CU-015 + CU-016 | UI aceptar / rechazar pedido (completar OrderInfoSheet) | Media |
| 6 | CU-018 + CU-019 | Implementar DirectionsView: marcar en camino + avisar llegada | Alta |
| 7 | CU-020 | Confirmar entrega (botón en DirectionsView) | Baja |
| 8 | CU-009 | Cancelar pedido desde App Chofer | Baja |
| 9 | CU-006 + CU-007 | Detalle e historial de pedidos del chofer | Media |
| 10 | CU-014 | Verificar si existe el cron de reintentos en el backend | Baja |

---

## Otros gaps menores (post App Chofer)

| CU | Componente | Pendiente |
|----|------------|-----------|
| CU-004 | App Cliente | Implementar edición de nombre y teléfono en perfil |
| CU-021 | App Cliente | Integrar Firebase Cloud Messaging (FCM) |
| CU-023 | App Cliente | Agregar UI para registrar un reclamo |

---

*Última actualización: 2026-05-07*
