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
- **Orden de locks real (el mismo en TODOS los caminos):**
  1. `gas_cylinder` de todas las garrafas de la operación, por id ascendente: `FOR UPDATE` si el
     vendible acompaña al físico (lo toma `ajustarVendible`, el mismo lock que `reservarStock`) y
     `FOR KEY SHARE` si no (entrega, transferencia). `KEY SHARE` es lo que la clave foránea del
     libro pide igual al insertar: se toma ANTES de los saldos, no choca con otras entregas ni
     transferencias y sólo espera a quien tenga `FOR UPDATE`. Nunca se sube de un modo a otro.
  2. `warehouse` con `FOR SHARE` (frena la baja del depósito mientras se usa).
  3. `stock_balance` de las filas involucradas, `FOR UPDATE` ordenadas por (ubicación, tipo, condición).
  4. `document_sequence` (número del ajuste), al final.
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

## Pendiente (partes 2 y 3)

Compras (proveedores, órdenes, recepciones) y carga/rendición del camión usan
`StockLedgerPort` (`aplicar` y `contraasentar`). Ver la entrega de la tanda.
