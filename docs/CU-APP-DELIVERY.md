# Casos de Uso — Sistema de Logística de Garrafas de Gas (Fase 1)
**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas  
**Metodología:** Unified Process (UP)  
**Versión:** 1.0  
**Fecha:** 2026-04-16  

---

## Actores del Sistema

| Código | Actor | Descripción |
|--------|-------|-------------|
| ACT-01 | Cliente | Usuario final que realiza pedidos de garrafas a través de la app móvil. |
| ACT-02 | Chofer | Repartidor que recibe, acepta y ejecuta las entregas mediante la app de choferes. |
| ACT-03 | Administrador | Operador del distribuidor que gestiona el sistema desde el panel web. |
| ACT-04 | Sistema (Automático) | Procesos internos del backend: despacho automático, cron de reintentos, reserva de stock. |

---

## Subsistemas

| Código | Subsistema | Actores involucrados |
|--------|------------|----------------------|
| SS-01 | Autenticación y Usuarios | ACT-01, ACT-02, ACT-03 |
| SS-02 | Gestión de Pedidos | ACT-01, ACT-02, ACT-03, ACT-04 |
| SS-03 | Despacho y Asignación | ACT-02, ACT-03, ACT-04 |
| SS-04 | Seguimiento en Tiempo Real | ACT-01, ACT-02 |
| SS-05 | Reclamos | ACT-01, ACT-03 |
| SS-06 | Reportes y Dashboard | ACT-03 |
| SS-07 | Gestión de Choferes y Vehículos | ACT-03 |
| SS-08 | Gestión de Productos e Inventario | ACT-03 |
| SS-09 | Franjas Horarias | ACT-01, ACT-03 |

---

## Lista de Casos de Uso

### Calificación
- **Crítico:** El sistema no puede funcionar sin este CU.
- **Importante:** Agrega valor significativo; es parte del MVP.
- **Secundario:** Deseable pero no bloquea la operación principal.

---

### SS-01 — Autenticación y Usuarios

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-001 | Iniciar Sesión | ACT-01, ACT-02, ACT-03 | Crítico |
| CU-002 | Registrarse como Cliente | ACT-01 | Crítico |
| CU-003 | Registrarse como Chofer | ACT-03 | Crítico |
| CU-004 | Gestionar Perfil de Usuario | ACT-01, ACT-02 | Importante |

---

### SS-02 — Gestión de Pedidos

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-005 | Crear Pedido | ACT-01 | Crítico |
| CU-006 | Consultar Detalle de Pedido | ACT-01, ACT-02, ACT-03 | Crítico |
| CU-007 | Consultar Historial de Pedidos | ACT-01 | Importante |
| CU-008 | Cancelar Pedido (Cliente) | ACT-01 | Importante |
| CU-009 | Cancelar Pedido (Chofer) | ACT-02 | Importante |
| CU-010 | Cancelar Pedido (Administrador) | ACT-03 | Importante |
| CU-011 | Listar Todos los Pedidos | ACT-03 | Importante |
| CU-012 | Asignar Chofer Manualmente | ACT-03 | Secundario |

---

### SS-03 — Despacho y Asignación

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-013 | Asignar Pedido Automáticamente por Proximidad | ACT-04 | Crítico |
| CU-014 | Reintentar Asignación con Radio Expandido (Cron) | ACT-04 | Crítico |
| CU-015 | Aceptar Pedido | ACT-02 | Crítico |
| CU-016 | Rechazar / Ignorar Pedido | ACT-02 | Importante |

---

### SS-04 — Seguimiento en Tiempo Real

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-017 | Actualizar Ubicación GPS del Chofer | ACT-02 | Crítico |
| CU-018 | Marcar Pedido "En Camino" | ACT-02 | Crítico |
| CU-019 | Avisar Llegada al Cliente | ACT-02 | Importante |
| CU-020 | Confirmar Entrega | ACT-02 | Crítico |
| CU-021 | Recibir Notificaciones en Tiempo Real | ACT-01 | Crítico |
| CU-022 | Activar / Desactivar Disponibilidad | ACT-02 | Crítico |

---

### SS-05 — Reclamos

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-023 | Registrar Reclamo | ACT-01 | Importante |
| CU-024 | Listar Reclamos | ACT-03 | Importante |
| CU-025 | Resolver Reclamo | ACT-03 | Importante |

---

### SS-06 — Reportes y Dashboard

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-026 | Ver Dashboard General | ACT-03 | Importante |
| CU-027 | Ver Reporte de Ventas por Chofer | ACT-03 | Importante |
| CU-028 | Ver Reporte de Ventas por Producto | ACT-03 | Importante |
| CU-029 | Ver Reporte por Método de Pago | ACT-03 | Secundario |
| CU-030 | Ver Gráfico de Ventas (últimos 7 días) | ACT-03 | Secundario |

---

### SS-07 — Gestión de Choferes y Vehículos

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-031 | Registrar Chofer | ACT-03 | Crítico |
| CU-032 | Validar / Invalidar Chofer | ACT-03 | Crítico |
| CU-033 | Activar / Desactivar Chofer (Admin) | ACT-03 | Importante |
| CU-034 | Registrar Vehículo del Chofer | ACT-03 | Importante |
| CU-035 | Consultar Listado de Choferes | ACT-03 | Importante |

---

### SS-08 — Gestión de Productos e Inventario

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-036 | Crear Producto (Garrafa) | ACT-03 | Crítico |
| CU-037 | Actualizar Precio de Producto | ACT-03 | Crítico |
| CU-038 | Actualizar Stock de Producto | ACT-03 | Crítico |
| CU-039 | Configurar Promociones por Cantidad | ACT-03 | Importante |
| CU-040 | Activar / Desactivar Producto | ACT-03 | Importante |
| CU-041 | Consultar Catálogo de Productos | ACT-01, ACT-03 | Crítico |

---

### SS-09 — Franjas Horarias

| Código | Nombre | Actor Principal | Calificación |
|--------|--------|-----------------|--------------|
| CU-042 | Crear Franja Horaria | ACT-03 | Importante |
| CU-043 | Modificar Capacidad de Franja Horaria | ACT-03 | Importante |
| CU-044 | Seleccionar Franja Horaria al Crear Pedido | ACT-01 | Importante |
| CU-045 | Consultar Franjas Horarias Disponibles | ACT-01 | Importante |

---

## Resumen de Calificación

| Calificación | Cantidad | CU |
|---|---|---|
| Crítico | 16 | CU-001, CU-002, CU-003, CU-005, CU-006, CU-013, CU-014, CU-015, CU-017, CU-018, CU-020, CU-021, CU-022, CU-031, CU-032, CU-036, CU-037, CU-038, CU-041 |
| Importante | 22 | CU-004, CU-007, CU-008, CU-009, CU-010, CU-011, CU-016, CU-019, CU-023, CU-024, CU-025, CU-026, CU-027, CU-028, CU-033, CU-034, CU-035, CU-039, CU-040, CU-042, CU-043, CU-044, CU-045 |
| Secundario | 4 | CU-012, CU-029, CU-030 |

---

## CU Priorizados para la Fase de Elaboración (Iteración 1)

Estos son los CU arquitectónicamente más significativos — los que validan las decisiones técnicas más riesgosas del sistema:

| Código | Nombre | Justificación |
|--------|--------|---------------|
| CU-005 | Crear Pedido | Involucra transacción atómica, reserva de stock y disparo del despacho automático |
| CU-013 | Asignar Pedido Automáticamente por Proximidad | Algoritmo central del sistema (Redis GEOADD/GEORADIUS) |
| CU-017 | Actualizar Ubicación GPS del Chofer | Valida la arquitectura WebSocket + Redis en tiempo real |
| CU-020 | Confirmar Entrega | Cierra el ciclo completo de negocio |
| CU-001 | Iniciar Sesión | Base de toda la seguridad del sistema (JWT + roles) |

---

## Notas para la Documentación UP

- Los **CU Críticos** deben tener CU Expandido completo en el Doc 1 (Requisitos).
- Los **CU Importantes** pueden documentarse como CU de Alto Nivel en primera instancia.
- Los **CU Secundarios** se documentan con descripción breve.
- Los CU priorizados para Elaboración deben tener **Diagrama de Secuencia a nivel de sistema** y **Contrato de operación** en el Doc 2 (Análisis).
- El Doc 3 (Diseño) requiere **CU Real con pantalla** para al menos los 5 CU priorizados.
