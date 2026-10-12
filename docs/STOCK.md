# Stock físico

Módulo `src/stock/` (M-C parte 1; el diseño completo está en
`.orquesta/runs/2026-10-03-modulos-empresa/DISENO-MODULOS.md`, sección 4).

## Modelo

| Tabla | Qué es |
|---|---|
| `warehouse` | Depósito de una distribuidora. Baja lógica; uno predeterminado vigente por distribuidora. |
| `stock_location` | Una ubicación = un depósito **o** un vehículo (se crea la primera vez que recibe stock). |
| `stock_balance` | Saldo materializado por ubicación, tipo de garrafa y condición (`full`, `empty`, `defective`). `quantity >= 0` por CHECK. |
| `stock_movement` | Libro **append-only** (trigger `stock_movement_inmutable`). Se corrige con un contraasiento (`reason = reversal`, `reversed_movement_id`). |
| `stock_adjustment` + `_item` | Documento numerado (`document_sequence`) con nota obligatoria. |
| `stock_threshold` | Mínimo de llenas por depósito y tipo; `alerted_at` evita repetir el aviso. |

## Reglas

- **`StockLedgerPort` (`StockLedgerService`) es el único que mueve stock.** Valida
  ubicaciones y garrafas contra la distribuidora (404), rechaza saldos negativos (400 con el
  detalle), actualiza saldos e inserta el libro, todo en la transacción de quien lo llama.
- **Orden de locks real** (lo siguen el ajuste, la transferencia, la entrega, la recepción y la anulación de compras,
  los contraasientos y el conteo inicial; el conteo es el único que además toma el depósito en EXCLUSIVO, pero recién
  después de las garrafas):
  1. `gas_cylinder` de todas las garrafas de la operación, por id ascendente: `FOR UPDATE` si el
     vendible acompaña al físico (lo toma `ajustarVendible`, el mismo lock que `reservarStock`) y
     `FOR KEY SHARE` si no (entrega, transferencia). `KEY SHARE` es lo que la clave foránea del
     libro pide igual al insertar: se toma ANTES de los saldos, no choca con otras entregas ni
     transferencias y sólo espera a quien tenga `FOR UPDATE`. Nunca se sube de un modo a otro.
  2. `warehouse` con `FOR SHARE` (frena la baja del depósito mientras se usa).
  3. `stock_balance` de las filas involucradas, `FOR UPDATE` ordenadas por (ubicación, tipo, condición).
  4. `document_sequence` (número del ajuste), al final.
  El conteo inicial también empieza por `gas_cylinder` (`FOR UPDATE`, por id) y recién después toma el depósito
  en exclusiva: tomarlo antes se cruzaba con un ajuste o una transferencia (garrafas y después depósito
  `FOR SHARE`) y daba deadlock; hay un test de integración con 12 conteos y 12 ajustes simultáneos.
  Sin el paso 1 una entrega tomaba saldos y recién al insertar el libro pedía `gas_cylinder`, al
  revés que un ajuste: deadlock. La entrega además reintenta su savepoint ante `40P01`.
- **Vendible (D4):** `gas_cylinder.stock = Σ llenas (depósitos y camiones) − Σ pedidos abiertos`
  (`reserved`, `pending`, `accepted`, `on_the_way`). Entrar o sacar llenas mueve el vendible lo
  mismo y nunca lo deja negativo; las transferencias no lo tocan. La entrega no lo toca (ya se
  descontó al reservar). `GET /stock/reconciliation` y el cron de las 03:00 ART lo verifican y
  avisan; **no corrigen**.
- **Entrega (D5 y D6):** al pasar un pedido a `delivered`, `UpdateOrderStatusUseCase` llama a
  `StockDeliveryPort` por el **mismo manager** de la transacción del pedido. Sale la llena del
  camión del pedido (`order.vehicle_car_id`) si tiene saldo; si no, del depósito predeterminado;
  entra una vacía de canje 1 a 1. Nunca bloquea la entrega: sin saldo en ningún lado queda para
  la conciliación (`deliveriesWithoutMovement`) y se reaplica con
  `POST /stock/reconciliation/reapply-deliveries`. Idempotente por pedido y garrafa.
- **Conteo inicial:** una vez por depósito; registra las diferencias contra el saldo actual como
  un ajuste `initial_count`. Los depósitos existentes arrancan con la migración `StockFisico`
  (llenas = vendible + pedidos abiertos, vacías en cero).
- **Ajustes:** `count_correction`, `shrinkage`, `leak`, `damaged` (llena a defectuosa), `lost`
  y `found`. Nota obligatoria. Un ajuste no se contraasienta: se corrige con otro ajuste.
- **Catálogo:** `PATCH /gascylinder/:id/stock` ahora es un ajuste `count_correction` de llenas en
  el depósito predeterminado; si restando no alcanzan las llenas ahí, el 400 dice dónde están las
  demás (camiones u otros depósitos). Un producto nuevo con `stock` registra el físico en la MISMA
  transacción del alta (`garrafa.creada` con `emitAsync` y el `manager`; si falla, no se crea).
  Editar un producto con `stock` responde 400: el stock se cambia con un ajuste.
- **Desvío del vendible:** `GET /stock/reconciliation` ofrece `correction` por garrafa y
  `POST /stock/reconciliation/adjustments` lo aplica: ajuste numerado y auditado con motivo
  `reconciliation`, nota obligatoria, que corrige SÓLO `gas_cylinder.stock` (sin movimientos
  físicos: el físico no cambió). El cron avisa una vez por diferencia (firma en
  `stock_reconciliation_alert`).
- **Depósito predeterminado:** no puede estar inactivo (400 al marcarlo si está inactivo o al marcarlo junto con
  `isActive: false`; desactivarlo o sacarle la marca da 409). La entrega acredita ahí la vacía de canje y un depósito
  inactivo no recibe stock: omitiría todo el pedido.
- **Entrega con carrera de saldo:** las lecturas de la entrega son sin lock a propósito. Si entre la lectura y el libro
  otra operación vacía un saldo (`StockInsuficienteError`), o hay deadlock, la entrega reintenta (3 veces, en un savepoint
  nuevo) RELEYENDO los saldos: se descuentan las garrafas que alcanzan y se omite sólo la que no. Se eligió el reintento
  y no partir la operación garrafa por garrafa porque conserva una sola operación del libro por pedido.
- **Estados:** un depósito inactivo o un vehículo dado de baja no reciben stock pero pueden
  entregar el que les queda.
- **Crons (zona `America/Argentina/Buenos_Aires`):** stock bajo 08:00 (mail a los admins, una
  vez por bajada) y conciliación 03:00 (mail si hay diferencias).

## Endpoints

Todos `@Auth(ADMIN, SUPER_ADMIN)` con la distribuidora en contexto; lo de otra responde 404.
Los `POST` que mueven stock aceptan `Idempotency-Key` (UUID v4).
Swagger: `GET /docs-json`. Rutas: `/warehouses`, `/stock`, `/stock/summary`, `/stock/locations`,
`/stock/movements`, `/stock/transfers`, `/stock/initial-counts`, `/stock/adjustments`,
`/stock/thresholds`, `/stock/reconciliation` (+ `/adjustments`, `/reapply-deliveries`),
`/stock/movements/batches/:batchId/reverse`.

## Compras (parte 2)

Módulo `src/purchase/`. Proveedores, órdenes de compra y recepciones (remito de ingreso). Toda
entrada y salida de garrafas pasa por `StockLedgerPort`; el módulo no escribe saldos.

| Tabla | Qué es |
|---|---|
| `supplier` | Proveedor. Baja lógica; CUIT único entre los vigentes de la distribuidora (formato y dígito verificador validados). Tipo `filling_plant` (planta fraccionadora) u `other`. |
| `purchase_order` + `_item` | Orden de compra numerada (`document_sequence`, tipo `purchase_order`). `received_quantity` por renglón, CHECK `0 <= recibido <= pedido`. |
| `purchase_receipt` + `_item` | Remito de ingreso, con o sin orden. Único `(distribuidora, proveedor, nº de documento del proveedor)`; la numeración interna usa el tipo `purchase_receipt`. |
| `gas_cylinder.average_unit_cost` | Costo promedio ponderado de las llenas compradas. |

**Estados de la orden:** `draft -> sent -> partially_received -> received`; `cancelled` (con motivo) desde
`draft` o `sent`; `closed_short` (cerrada con faltante, con motivo) desde `partially_received`. Las
transiciones viven en `domain/purchase-rules.ts`. Sólo se edita en borrador.
- **Cancelar** una orden con recepciones confirmadas —cualquiera, incluso sólo de vacías— responde **409**;
  se anulan primero, o se cierra con faltante. Con todas anuladas se puede cancelar.
- **Cerrar con faltante** (`PATCH /purchase-orders/:id/close-short`, motivo obligatorio): lo que falta ya no
  llega. Se eligió un estado propio y no `cancelled` porque la orden SÍ recibió mercadería: cancelada
  significaría "no se compró nada" y mezclaría los dos casos en los reportes. `pendingQuantity` pasa a 0 y
  deja de bloquear la baja del proveedor. Sus recepciones se siguen pudiendo anular y la orden conserva el estado.
- Anular una recepción de una orden `sent`/`partially_received`/`received` recalcula su estado (puede volver a
  `partially_received` o `sent`); en una `cancelled` o `closed_short` el estado no cambia.

**Recepción (`POST /purchase-receipts`), una transacción:**
1. lock de la orden (`FOR UPDATE`) y validación: sólo `sent` o `partially_received`, garrafas de la orden,
   cada renglón <= lo pendiente (400 con el detalle);
2. ledger: `+llenas` (`purchase_receipt`) en el depósito destino, que sube el vendible (D4), y `-vacías`
   (`plant_empty_out`) que se lleva la planta. Si las vacías no alcanzan: 400 con el detalle y no se escribe nada;
3. costo promedio: `(existencia previa x costo previo + llenas x costo nuevo) / (existencia previa + llenas)`,
   redondeado a 2 decimales; la existencia son las llenas de depósitos y camiones antes de la recepción. En
   cada renglón se guardan `previous_average_cost` y `previous_on_hand` (el promedio y la existencia de antes);
4. `received_quantity` y estado de la orden; 5. número interno y remito.
Documento del proveedor: único por `(distribuidora, proveedor, tipo, número)`: remito y factura numeran aparte.
Límites de los DTO (`dto/purchase-limits.ts`): 20 renglones, 5.000 unidades y $90.000 por garrafa, para que
ningún total desborde `numeric(12,2)`; `traducirErrorDeBase` además traduce `22003` a 400.

**Anular (`PATCH /purchase-receipts/:id/void`):** contraasiento del lote por el ledger (las llenas salen del
depósito, las vacías vuelven). Si las llenas ya no están en el depósito (vendidas, cargadas a un camión,
transferidas) responde **409** y dice dónde están hoy. No se anula una recepción marcada como pagada (400).

**Costo promedio al anular** (`costoPromedioAlAnular`). Las ventas, mermas y ajustes NO cambian el promedio
(sólo una compra lo cambia), por eso:
1. si no queda otra recepción confirmada de esa garrafa, el costo vuelve a `null`;
2. si es la última compra, vuelve EXACTO al `previous_average_cost` guardado, hayan pasado las ventas que hayan pasado;
3. si hubo compras posteriores no se puede reconstruir exacto: se resta del promedio de hoy lo que esta
   compra lo había movido, `cantidad x (costo recibido - costo previo) / (existencia previa + cantidad)`, con
   piso en 0 (las compras posteriores lo diluyeron: es una aproximación);
4. si antes no había costo previo, el promedio de las otras compras confirmadas;
5. una recepción anterior a esta columna (sin snapshot) deja el promedio como está.

**Pago:** `payment_status` (`unpaid`/`paid`) es sólo una marca (`PATCH /purchase-receipts/:id/payment-status`).
`cash_movement_id` queda en `null` hasta que exista el módulo de caja (M-D), sin clave foránea.

**Orden de locks de compras** (se suma al de arriba, empezando antes):
`purchase_order` -> `purchase_receipt` -> `gas_cylinder` (los toma el ledger) -> `warehouse` -> `stock_balance` ->
`document_sequence` (el número del remito y de la orden, al final). Anular toma la orden y después el remito.
Nada toma `gas_cylinder` y luego `purchase_order`. Crear/editar una orden toma las garrafas con `FOR KEY SHARE`
(lo que pide la clave foránea del renglón) antes de la secuencia, y el proveedor con `FOR SHARE` (frena su baja).
Dos recepciones simultáneas de la misma orden se serializan en el lock de la orden: la segunda ve lo recibido por
la primera.

**Endpoints** (`@Auth(ADMIN, SUPER_ADMIN)`, distribuidora en contexto, lo de otra responde 404; los `POST`/`void`
que mueven stock o numeran aceptan `Idempotency-Key`):

| Método | Ruta |
|---|---|
| GET, POST | `/suppliers` |
| GET, PATCH, DELETE | `/suppliers/:id` |
| GET | `/suppliers/:id/purchase-history` |
| GET, POST | `/purchase-orders` (`status`, `supplierId`, `from`, `to`) |
| GET, PATCH | `/purchase-orders/:id` |
| GET | `/purchase-orders/:id/pending` |
| PATCH | `/purchase-orders/:id/send`, `/purchase-orders/:id/cancel`, `/purchase-orders/:id/close-short` |
| GET, POST | `/purchase-receipts` (`supplierId`, `purchaseOrderId`, `paymentStatus`, `status`, `from`, `to`) |
| GET | `/purchase-receipts/average-costs`, `/purchase-receipts/:id` |
| PATCH | `/purchase-receipts/:id/void`, `/purchase-receipts/:id/payment-status` |

## Pendiente (parte 3)

La carga y rendición del camión usa `StockLedgerPort` (`aplicar` y `contraasentar`). La caja de las compras
(M-D) completará `cash_movement_id`. Ver la entrega de la tanda.
