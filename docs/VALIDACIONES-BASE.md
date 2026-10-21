# Validaciones en la base (tanda V1)

Regla del proyecto: toda regla de negocio se valida en el front, en el back y en la
base. Esta tanda lleva a la base las reglas de datos (CHECK, únicos, exclusiones,
claves foráneas) y cierra huecos del back. El back responde un 400/409 legible
**antes** de que salte la restricción; si algo se escapa (dos operaciones a la vez),
`traducirErrorDeBase` y el filtro global traducen la violación con el mensaje de
`src/common/errors/restricciones-de-base.ts` (23514 → 400; 23505 y 23P01 → 409).

Verificación de la base: `scripts/verificar-constraints.sql` (transacción con ROLLBACK):

    docker exec -i splg-bd psql -U postgres -d splg_db -v ON_ERROR_STOP=1 < scripts/verificar-constraints.sql

## Migraciones (en orden)

| Migración | Qué hace |
|---|---|
| `NormalizarCuitDeDistribuidora` | `distributor.tax_id` queda sólo con dígitos. |
| `RecargoPorMedioDePagoEnPedido` | Columna `order.payment_surcharge_amount` (numeric(10,2) NOT NULL DEFAULT 0) y carga de los pedidos existentes (total menos ítems, zona y express). |
| `DatosDeLasValidacionesDeLaBase` | Cancelados sin motivo → «Sin motivo registrado»; prioridad de zonas activas renumerada sin repetidos (conserva quién gana); patentes en mayúsculas sin espacios. |
| `ChecksDeLaBase` | ~90 CHECK (NOT VALID + VALIDATE), funciones `es_cuit_valido` / `es_cuil_valido`, promoción máxima 99 %. |
| `UnicidadesDeLaBase` | Únicos: `lower(email)`, patente por distribuidora, dirección principal, oferta viva/aceptada, renglón por garrafa, franja y zona por nombre (activas), prioridad de zona (activas), serial y tipo normalizados, orden de parada. |
| `ClavesForaneasFaltantes` | 8 FK que faltaban (`order.payment_confirmed_by`, `payment_resolved_by`, `vehicle_car_id`, `payment_refund.requested_by_user_id`, `purchase_receipt.voided_by_user_id` y `cash_movement_id`, `fuel_load.cash_movement_id`, `traffic_fine.cash_movement_id`). |
| `SaldoDelChoferNumerico` | `delivery.balance` pasa a numeric(12,2). |
| `ExclusionesDeLaBase` | `btree_gist` y EXCLUDE: franjas, jornadas, asignación de vehículo (por vehículo y por chofer), reglas de comisión. |
| `BorradoRestrictivoDeUsuariosYPedidos` | `user` → customer/delivery/car/user_address/admin y `order` → rating/incident/historial/cambios de dirección pasan a RESTRICT. |
| `EstadoDelPagoYMovimientoDeEnvase` | `CHK_cylinder_movement_cambio` admite un movimiento sin cambio de estado si trae nota (la anotación de una revisión rechazada de un envase que está afuera); trigger `TRG_payment_estado_no_retrocede` (un pago aprobado sólo pasa a devuelto; rechazado, cancelado y devuelto no cambian). |
| `FormulaDelTotalDelPedido` | `CHK_order_total_formula`: total = ítems + zona + recargo online + express (el express no cuenta si el pedido pasó al reparto común). Va última porque exige que todo el back que crea o edita pedidos complete `payment_surcharge_amount`. |

## Reglas del back que cambian

- **Pedido**: `items` no puede ser vacío; el recargo online se guarda aparte (`paymentSurchargeAmount`) en alta, edición y cambio de dirección, y el total es la suma exacta; `scheduledDate` no puede ser pasada (día argentino), con o sin franja; cancelar exige motivo (cliente y admin; el chofer, que libera, no): `PATCH /orders/:id/cancel`, `PATCH /orders/:id/status` con `cancelled` (usa `reason`) y las cancelaciones automáticas dejan su motivo. `DELETE /orders/:id` (deprecado) manda un motivo fijo.
- **Pagos**: un pago aprobado no retrocede (pending/rejected/cancelled atrasados se ignoran; sólo puede pasar a refunded); si la pasarela aprueba un importe distinto del esperado, el pago queda marcado en `metadata.montoDistinto`, se registra una alerta (log ERROR) y el pedido no se da por pagado ni se despacha.
- **Despacho**: una oferta sólo se cierra desde `offered` (el vencimiento no pisa una aceptada); un pedido tiene un solo chofer que lo sostiene.
- **Franjas**: inicio < fin, capacidad 1–10000, nombre único y sin solaparse entre activas (409).
- **Zonas**: nombre y prioridad únicos entre activas (409); sin prioridad en el alta, queda la siguiente.
- **Catálogo**: tipo sin blancos y único sin distinguir mayúsculas/espacios; precio hasta 10.000.000 y peso hasta 1000 kg, 2 decimales; promoción 0,01–99 %.
- **Envases**: serial no vacío, recortado y en mayúsculas (alta, edición y asignación); fabricación ≤ vencimiento; una revisión no puede ser anterior a la fabricación.
- **Cuentas corrientes**: máquina de estados `active ↔ blocked`, `active|blocked → closed`, `closed → active` (cerrada no pasa a bloqueada).
- **Flota**: patente argentina `AAA123` o `AA123AA` (409 si ya existe en la distribuidora); odómetro de combustible contra la carga anterior **y la siguiente**; multas: infracción no futura, vencimiento ≥ infracción, pago ≥ infracción; cerrar/cancelar una tarea bloquea la fila y la fecha de cierre no es futura; el saldo del chofer se ajusta con la fila bloqueada y en decimal.
- **Personas**: teléfono E.164 también al editar y único; nacimiento anterior al ingreso; CUIT de la distribuidora con 11 dígitos (acepta guiones y los quita).
- **Direcciones**: una sola principal; al mover la principal se desmarca la vieja antes de marcar la nueva.

## Deshacer las migraciones

Política: un `down` nunca pierde datos en silencio. Si volver atrás exige descartar o decidir sobre datos que el esquema nuevo permitía, **aborta antes de tocar nada** con un diagnóstico (qué filas y cómo consultarlas); quien revierte decide, borra o corrige a mano y reintenta.

- `UnicidadesDeLaBase.down` vuelve la patente a única en todo el sistema. Si ya hay patentes vigentes repetidas entre distribuidoras (algo legítimo con V1), **aborta antes de tocar nada** con un mensaje que lista las patentes: hay que dar de baja o cambiar las repetidas y reintentar.
- `EstadoDelPagoYMovimientoDeEnvase.down` restaura el CHECK estricto de `cylinder_movement`: si hay movimientos con mismo estado de origen y destino (anotaciones de revisiones rechazadas) aborta con la cantidad y la consulta para verlos.
- `btree_gist` queda instalada al deshacer `ExclusionesDeLaBase`.
- Las migraciones de datos (`NormalizarCuitDeDistribuidora`, `DatosDeLasValidacionesDeLaBase`) no se pueden revertir: su `down` no hace nada.
- `FormulaDelTotalDelPedido` completa `payment_surcharge_amount` en los pedidos creados mientras tanto con la diferencia.

## Pruebas de integración

El esquema de las suites sale de las entidades (`DB_SYNC`), así que el arranque del Postgres efímero (`test/integration/setup/test-env.ts`) corre un script inicial que crea `btree_gist` y las funciones `es_cuit_valido` / `es_cuil_valido` (la misma definición que usa la migración, en `src/migrations/sql/funciones-cuit.ts`) antes de que la app sincronice; y, una vez creado el esquema, instala el trigger `TRG_payment_estado_no_retrocede` desde las mismas definiciones (`src/migrations/sql/estado-del-pago.ts`). Los pedidos de los fixtures cumplen las reglas nuevas con `test/integration/setup/pedido-valido.ts` (chofer y fechas según el estado, motivo al cancelar).

## Pago: atomicidad y alerta de monto

`PaymentsService.updateLedger` lee, valida y escribe dentro de una transacción con el pago bloqueado (`FOR UPDATE`); el trigger de la base es la segunda barrera. La marca `metadata.montoDistinto` es persistente: cualquier notificación posterior del mismo pago (aun un `pending` atrasado) la sigue informando y `ConfirmPaymentUseCase` no despacha.
