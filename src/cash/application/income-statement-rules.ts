/**
 * Fragmentos SQL con las reglas de qué cuenta en el estado de resultados.
 * Los usan el reporte y el filtro «sólo los que cuentan» del listado de movimientos,
 * para que el conteo de una fila del reporte coincida con lo que se ve al abrirla.
 * `m` es el alias del movimiento en la consulta que los incluye.
 */

/**
 * La apertura de sesión que carga el saldo inicial de una caja: la primera de la caja,
 * sin ningún movimiento anterior. No es un ingreso, es la plata con que la caja arranca.
 */
export const ES_CARGA_INICIAL = `(m."reference_type" = 'session_opening' AND NOT EXISTS (
  SELECT 1 FROM "cash_movement" p
   WHERE p."cash_box_id" = m."cash_box_id" AND p."movement_id" <> m."movement_id"
     AND (p."occurred_at" < m."occurred_at" OR p."createdAt" < m."createdAt")))`;

/**
 * Pata de una transferencia entre cajas, o contraasiento de una: plata que cambia de caja.
 * Un contraasiento hereda lo que es su original.
 */
export const ES_TRANSFERENCIA = `(COALESCE(
  (SELECT o."reference_type"::text FROM "cash_movement" o WHERE o."movement_id" = m."reverses_movement_id"),
  m."reference_type"::text) = 'box_transfer')`;

/** Lo que cuenta como ingreso o egreso: todo menos transferencias y la carga inicial. */
export const CUENTA_PARA_EL_RESULTADO = `NOT ${ES_TRANSFERENCIA} AND NOT ${ES_CARGA_INICIAL}`;
