/**
 * Tenant cruzado: claves foráneas compuestas `(id, distributor_id)` que impiden que
 * una fila apunte a otra de OTRA distribuidora (la FK simple sólo garantiza que el
 * registro exista). Cada una agrega una restricción a la FK simple de siempre (que
 * conserva su `ON DELETE`): PostgreSQL 14 no admite `SET NULL (columna)`, así que
 * reemplazarla cambiaría el borrado. Las entidades las declaran con `@ForeignKey`
 * y `@Unique` para que TypeORM no las vea como diferencia.
 *
 * Quedan fuera los pagos (`payment`, `payment_refund`): son el ledger de
 * MercadoPago y esta tanda no los toca.
 */
export type ClaveForaneaDeDistribuidora = readonly [
  hijo: string,
  columna: string,
  padre: string,
];

/** Clave primaria de cada tabla padre. */
export const CLAVE_DEL_PADRE: Readonly<Record<string, string>> = {
  conversation: 'conversation_id',
  message: 'message_id',
  support_ticket: 'ticket_id',
  cash_box: 'cash_box_id',
  cash_session: 'session_id',
  cash_category: 'category_id',
  cash_movement: 'movement_id',
  customer_account: 'account_id',
  order: 'order_id',
  delivery: 'delivery_id',
  employee: 'employee_id',
  truck_load: 'load_id',
  purchase_order: 'purchase_order_id',
  supplier: 'supplier_id',
  warehouse: 'warehouse_id',
  driver_liquidation: 'liquidation_id',
  stock_movement: 'movement_id',
  stock_location: 'location_id',
  gas_cylinder: 'gas_cylinder_id',
  car: 'car_id',
  coverage_zone: 'coverage_zone_id',
  time_slot: 'time_slot_id',
  cylinder: 'cylinder_id',
  insurer: 'insurer_id',
  insurance_policy: 'policy_id',
  attachment: 'attachment_id',
  document_reading: 'reading_id',
  customer_container_account: 'account_id',
  mp_reconciliation: 'reconciliation_id',
  staff_role: 'staff_role_id',
  claims: 'claim_id',
  assistant_knowledge_base: 'knowledge_base_id',
};

export const CLAVES_CRUZADAS: readonly ClaveForaneaDeDistribuidora[] = [
  ['cash_movement', 'cash_box_id', 'cash_box'],
  ['cash_movement', 'session_id', 'cash_session'],
  ['cash_movement', 'category_id', 'cash_category'],
  ['cash_movement', 'reverses_movement_id', 'cash_movement'],
  ['cash_session', 'cash_box_id', 'cash_box'],
  ['customer_account_entry', 'account_id', 'customer_account'],
  ['customer_account_entry', 'cash_movement_id', 'cash_movement'],
  ['customer_account_entry', 'order_id', 'order'],
  ['customer_account_entry', 'collected_by_delivery_id', 'delivery'],
  ['driver_liquidation', 'cash_movement_id', 'cash_movement'],
  ['driver_liquidation', 'employee_id', 'employee'],
  ['driver_settlement', 'destination_cash_box_id', 'cash_box'],
  ['driver_settlement', 'cash_movement_id', 'cash_movement'],
  ['driver_settlement', 'delivery_id', 'delivery'],
  ['driver_settlement', 'truck_load_id', 'truck_load'],
  ['purchase_receipt', 'cash_movement_id', 'cash_movement'],
  ['purchase_receipt', 'purchase_order_id', 'purchase_order'],
  ['purchase_receipt', 'supplier_id', 'supplier'],
  ['purchase_receipt', 'warehouse_id', 'warehouse'],
  ['purchase_order', 'supplier_id', 'supplier'],
  ['purchase_order', 'destination_warehouse_id', 'warehouse'],
  ['fuel_load', 'cash_movement_id', 'cash_movement'],
  ['traffic_fine', 'cash_movement_id', 'cash_movement'],
  ['commission_entry', 'order_id', 'order'],
  ['commission_entry', 'employee_id', 'employee'],
  ['commission_entry', 'delivery_id', 'delivery'],
  ['commission_entry', 'liquidation_id', 'driver_liquidation'],
  ['stock_movement', 'gas_cylinder_id', 'gas_cylinder'],
  ['stock_movement', 'from_location_id', 'stock_location'],
  ['stock_movement', 'to_location_id', 'stock_location'],
  ['stock_movement', 'reversed_movement_id', 'stock_movement'],
  ['stock_balance', 'location_id', 'stock_location'],
  ['stock_balance', 'gas_cylinder_id', 'gas_cylinder'],
  ['stock_adjustment', 'location_id', 'stock_location'],
  ['stock_location', 'warehouse_id', 'warehouse'],
  ['stock_location', 'car_id', 'car'],
  ['stock_threshold', 'warehouse_id', 'warehouse'],
  ['stock_threshold', 'gas_cylinder_id', 'gas_cylinder'],
  ['truck_load', 'origin_location_id', 'stock_location'],
  ['truck_load', 'car_id', 'car'],
  ['truck_load', 'delivery_id', 'delivery'],
  ['truck_load', 'helper_employee_id', 'employee'],
  ['order', 'delivery_id', 'delivery'],
  ['order', 'coverage_zone_id', 'coverage_zone'],
  ['order', 'time_slot_id', 'time_slot'],
  ['order', 'vehicle_car_id', 'car'],
  ['order_dispatch_offer', 'order_id', 'order'],
  ['rating', 'order_id', 'order'],
  ['incident', 'order_id', 'order'],
  ['claims', 'order_id', 'order'],
  ['cylinder', 'gas_cylinder_id', 'gas_cylinder'],
  ['cylinder', 'current_order_id', 'order'],
  ['cylinder_movement', 'cylinder_id', 'cylinder'],
  ['cylinder_movement', 'order_id', 'order'],
  ['cylinder_inspection', 'cylinder_id', 'cylinder'],
];

/**
 * Las claves cruzadas de las tablas que nacieron después de la migración
 * `TenantCruzado`: cada migración de esas tablas las crea con su `CREATE TABLE`
 * (la migración `TenantCruzado` no las toca, no existen todavía cuando corre).
 * Siguen el mismo nombre y la misma forma, y el test las compara con las entidades.
 */
export const CLAVES_CRUZADAS_POSTERIORES: readonly ClaveForaneaDeDistribuidora[] =
  [
    // Seguros de los vehículos (F14)
    ['insurance_policy', 'car_id', 'car'],
    ['insurance_policy', 'insurer_id', 'insurer'],
    ['insurance_installment', 'policy_id', 'insurance_policy'],
    ['insurance_installment', 'cash_movement_id', 'cash_movement'],
    // Comprobante de la multa (F15)
    ['traffic_fine', 'receipt_attachment_id', 'attachment'],
    // Gastos de la flota pagados desde una caja
    ['maintenance_task', 'cash_movement_id', 'cash_movement'],
    ['tire', 'cash_movement_id', 'cash_movement'],
    ['vehicle_accident', 'payment_cash_movement_id', 'cash_movement'],
    ['vehicle_accident', 'reimbursement_cash_movement_id', 'cash_movement'],
    // Cajas de cobro de las ventas (Mercado Pago y transferencias)
    ['cash_collection_settings', 'mercadopago_cash_box_id', 'cash_box'],
    ['cash_collection_settings', 'transfer_cash_box_id', 'cash_box'],
    // Diferencias de la conciliación con Mercado Pago
    ['mp_reconciliation_item', 'reconciliation_id', 'mp_reconciliation'],
    // Hoja de ruta (lote de modalidad `planned`)
    ['route_batch', 'car_id', 'car'],
    ['route_batch', 'origin_warehouse_id', 'warehouse'],
    ['route_batch', 'truck_load_id', 'truck_load'],
    // Lecturas de documentos (módulo M6)
    ['document_reading', 'attachment_id', 'attachment'],
    ['document_reading', 'duplicate_of_id', 'document_reading'],
    ['document_reading_example', 'source_reading_id', 'document_reading'],
    // Cuenta de envases (F35 E2)
    ['customer_container_account', 'gas_cylinder_id', 'gas_cylinder'],
    ['customer_container_movement', 'account_id', 'customer_container_account'],
    ['customer_container_movement', 'order_id', 'order'],
    // Rol del personal del admin (F37 E1)
    ['admin', 'staff_role_id', 'staff_role'],
    // Mensajería: chat con la plataforma y tickets (CH1)
    ['conversation_party', 'conversation_id', 'conversation'],
    ['conversation_read_state', 'conversation_id', 'conversation'],
    ['message', 'conversation_id', 'conversation'],
    ['support_ticket', 'conversation_id', 'conversation'],
    ['support_ticket', 'origin_conversation_id', 'conversation'],
    ['support_ticket_message_link', 'ticket_id', 'support_ticket'],
    ['support_ticket_message_link', 'message_id', 'message'],
    ['support_ticket_message_link', 'quoted_in_message_id', 'message'],
    // Mensajería: bandeja de la empresa (CH3)
    ['conversation', 'order_id', 'order'],
    ['conversation', 'linked_claim_id', 'claims'],
    ['message_edit', 'message_id', 'message'],
    // Asistente del chat: base de conocimiento (CH-BOT B2). Las de la
    // plataforma (`distributor_id` nulo) las cubre la FK simple a la base.
    ['assistant_faq', 'knowledge_base_id', 'assistant_knowledge_base'],
    // Trazas del asistente con IA (CH-BOT B3)
    ['assistant_trace', 'conversation_id', 'conversation'],
    ['assistant_trace', 'trigger_message_id', 'message'],
    ['assistant_trace', 'reply_message_id', 'message'],
    // Menciones en las notas internas de la bandeja (4a)
    ['message_mention', 'message_id', 'message'],
    ['message_mention', 'conversation_id', 'conversation'],
    // Encuesta de satisfacción al cerrar (4b)
    ['conversation_rating', 'conversation_id', 'conversation'],
    ['conversation_rating', 'request_message_id', 'message'],
    // Adjuntos del chat (CH7)
    ['attachment', 'message_id', 'message'],
  ];

export const nombreDeLaClave = (hijo: string, columna: string): string =>
  `FK_${hijo}_${columna.replace(/_id$/, '')}_distribuidora`;
export const nombreDelUnicoDelPadre = (padre: string): string =>
  `UQ_${padre}_id_distribuidora`;

/** Tablas que necesitan el único `(id, distributor_id)` para ser referenciadas. */
export const PADRES = [...new Set(CLAVES_CRUZADAS.map(([, , p]) => p))];

/** Tablas de las claves posteriores que no estaban en `PADRES` y declaran su único `(id, distributor_id)` al crearse. */
export const PADRES_POSTERIORES = [
  ...new Set(CLAVES_CRUZADAS_POSTERIORES.map(([, , p]) => p)),
].filter((p) => !PADRES.includes(p));

/** Filas de `hijo` cuya referencia es de otra distribuidora. */
export const sqlDeViolaciones = (
  hijo: string,
  columna: string,
  padre: string,
): string =>
  `SELECT count(*)::int AS total FROM "${hijo}" c JOIN "${padre}" p ON p."${CLAVE_DEL_PADRE[padre]}" = c."${columna}" WHERE p."distributor_id" <> c."distributor_id"`;

export const sqlDeUnicoDelPadre = (padre: string): string =>
  `ALTER TABLE "${padre}" ADD CONSTRAINT "${nombreDelUnicoDelPadre(padre)}" UNIQUE ("${CLAVE_DEL_PADRE[padre]}", "distributor_id")`;

export const sqlDeClave = (
  hijo: string,
  columna: string,
  padre: string,
): string =>
  `ALTER TABLE "${hijo}" ADD CONSTRAINT "${nombreDeLaClave(hijo, columna)}" FOREIGN KEY ("${columna}", "distributor_id") REFERENCES "${padre}" ("${CLAVE_DEL_PADRE[padre]}", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`;
