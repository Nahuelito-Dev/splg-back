/**
 * Modalidad del lote. `offer` es la agrupación dinámica de M4 (se le ofrece a
 * un chofer); `planned` es la hoja de ruta que el administrador arma y
 * confirma el día anterior.
 */
export enum RouteBatchKind {
  OFFER = 'offer',
  PLANNED = 'planned',
}

/**
 * `forming` y `offered` son de la modalidad `offer`; `draft` y `confirmed`, de
 * la `planned`. `assigned` (en curso), `completed` y `dissolved` las comparten.
 */
export enum RouteBatchStatus {
  FORMING = 'forming',
  OFFERED = 'offered',
  DRAFT = 'draft',
  CONFIRMED = 'confirmed',
  ASSIGNED = 'assigned',
  DISSOLVED = 'dissolved',
  COMPLETED = 'completed',
}
