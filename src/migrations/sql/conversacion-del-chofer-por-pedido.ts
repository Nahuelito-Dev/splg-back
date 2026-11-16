/**
 * Corrección 1 de CH3: la conversación C2 por pedido es del pedido y del
 * chofer (en C3 el chofer es nulo). Lo comparten la migración
 * `ConversacionDelChoferPorPedido` y el arranque de las pruebas de integración
 * (después de `sql/mensajes-retirados.ts`).
 */
const NULO = `'00000000-0000-0000-0000-000000000000'::uuid`;

export function sentenciasDelPedidoPorChofer(): string[] {
  return [
    `DROP INDEX IF EXISTS "UQ_conversation_pedido_abierta"`,
    `CREATE UNIQUE INDEX "UQ_conversation_pedido_abierta" ON "conversation" ("channel", "order_id", COALESCE("driver_user_id", ${NULO})) WHERE "subject_type" = 'order' AND "status" = 'open' AND "deleted_at" IS NULL`,
  ];
}

export function sentenciasParaQuitarElPedidoPorChofer(): string[] {
  return [
    `DROP INDEX IF EXISTS "UQ_conversation_pedido_abierta"`,
    `CREATE UNIQUE INDEX "UQ_conversation_pedido_abierta" ON "conversation" ("channel", "order_id") WHERE "subject_type" = 'order' AND "status" = 'open' AND "deleted_at" IS NULL`,
  ];
}
