/**
 * Procedimientos almacenados de las conciliaciones nocturnas (se llaman con
 * `CALL`). Los crea la migración `ProcedimientosDeConciliacion` y también el
 * arranque de la base de las pruebas de integración (el esquema sincronizado
 * desde las entidades no trae procedimientos).
 *
 * Reglas:
 *  - Controlan la transacción (`COMMIT`/`ROLLBACK`), así que NO se pueden
 *    llamar dentro de una transacción: «invalid transaction termination».
 *  - El actor de auditoría (`set_config(..., true)`) vive en la transacción y
 *    no sobrevive al `COMMIT` inicial: estos procedimientos no escriben tablas
 *    auditadas (la alerta de stock no lo es).
 *  - Las escrituras van en el cuerpo principal; los bloques `EXCEPTION` sólo
 *    capturan el error. Con error: `ROLLBACK` y se relanza con el mismo
 *    SQLSTATE.
 */
export const CREAR_CONCILIAR_STOCK_DEL_DIA = `
CREATE PROCEDURE conciliar_stock_del_dia(
  p_distribuidora uuid,
  INOUT p_consistente boolean DEFAULT NULL,
  INOUT p_avisar boolean DEFAULT NULL,
  INOUT p_firma text DEFAULT NULL,
  INOUT p_resultado jsonb DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_error text;
  v_sqlstate text;
  v_inicio timestamptz;
  v_garrafas jsonb;
  v_entregas jsonb;
  v_previa text;
BEGIN
  IF p_distribuidora IS NULL
     OR NOT EXISTS (SELECT 1 FROM "distributor" WHERE "distributor_id" = p_distribuidora) THEN
    RAISE EXCEPTION 'conciliar_stock_del_dia: la distribuidora % no existe', p_distribuidora
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Las tres cifras (vendible, físico, reservado) tienen que ser del mismo instante.
  COMMIT;
  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

  -- Lectura: el bloque sólo captura el error.
  BEGIN
    SELECT MIN("createdAt") INTO v_inicio
      FROM "stock_movement" WHERE "distributor_id" = p_distribuidora;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'gasCylinderId', x."gas_cylinder_id",
             'gasCylinderType', x."type",
             'sellable', x."stock",
             'physicalFull', x."fisico",
             'reserved', x."reservado",
             'expected', GREATEST(0, x."fisico" - x."reservado"),
             'overReserved', GREATEST(0, x."reservado" - x."fisico"),
             'difference', x."stock" - GREATEST(0, x."fisico" - x."reservado"),
             'reservationDeficit', x."reservation_deficit",
             'deficitDifference', x."reservation_deficit" - GREATEST(0, x."reservado" - x."fisico")
           ) ORDER BY x."type"), '[]'::jsonb)
      INTO v_garrafas
      FROM (
        SELECT g."gas_cylinder_id", g."type", g."stock", g."reservation_deficit",
               COALESCE((SELECT SUM(b."quantity") FROM "stock_balance" b
                          WHERE b."distributor_id" = p_distribuidora AND b."condition" = 'full'
                            AND b."gas_cylinder_id" = g."gas_cylinder_id"), 0)::int AS "fisico",
               COALESCE((SELECT SUM(i."quantity") FROM "order_item" i
                           JOIN "order" o ON o."order_id" = i."order_id"
                          WHERE o."distributor_id" = p_distribuidora
                            AND o."status" IN ('reserved', 'pending', 'accepted', 'on_the_way')
                            AND i."gas_cylinder_id" = g."gas_cylinder_id"), 0)::int AS "reservado"
          FROM "gas_cylinder" g
         WHERE g."distributor_id" = p_distribuidora
      ) x;

    -- Renglones entregados desde el arranque del libro que no descontaron el físico.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'orderId', o."order_id",
             'deliveredAt', o."deliveredAt",
             'gasCylinderId', i."gas_cylinder_id",
             'gasCylinderType', COALESCE(g."type", i."gas_cylinder_id"::text),
             'quantity', i."quantity"
           ) ORDER BY o."deliveredAt", o."order_id"), '[]'::jsonb)
      INTO v_entregas
      FROM "order" o
      JOIN "order_item" i ON i."order_id" = o."order_id"
      LEFT JOIN "gas_cylinder" g
        ON g."gas_cylinder_id" = i."gas_cylinder_id" AND g."distributor_id" = p_distribuidora
     WHERE o."distributor_id" = p_distribuidora
       AND o."status" = 'delivered'
       AND o."deliveredAt" >= v_inicio
       AND NOT EXISTS (
         SELECT 1 FROM "stock_movement" m
          WHERE m."distributor_id" = p_distribuidora AND m."reference_type" = 'order'
            AND m."reason" = 'delivery' AND m."reference_id" = o."order_id"
            AND m."gas_cylinder_id" = i."gas_cylinder_id");

    p_consistente := NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_garrafas) e
         WHERE (e->>'difference')::int <> 0 OR (e->>'overReserved')::int > 0
            OR (e->>'deficitDifference')::int <> 0)
      AND jsonb_array_length(v_entregas) = 0;
    p_resultado := jsonb_build_object(
      'consistent', p_consistente,
      'cylinders', v_garrafas,
      'deliveriesWithoutMovement', v_entregas);

    IF NOT p_consistente THEN
      -- Huella de las diferencias: cambia si cambia una cifra o una entrega pendiente.
      SELECT encode(sha256(convert_to(COALESCE(string_agg(h."parte", '|' ORDER BY h."parte" COLLATE "C"), ''), 'UTF8')), 'hex')
        INTO p_firma
        FROM (
          SELECT 'c:' || (e->>'gasCylinderId') || ':' || (e->>'difference') || ':'
                 || (e->>'overReserved') || ':' || (e->>'deficitDifference') AS "parte"
            FROM jsonb_array_elements(v_garrafas) e
           WHERE (e->>'difference')::int <> 0 OR (e->>'overReserved')::int > 0
              OR (e->>'deficitDifference')::int <> 0
          UNION ALL
          SELECT 'e:' || (e->>'orderId') || ':' || (e->>'gasCylinderId')
            FROM jsonb_array_elements(v_entregas) e
        ) h;
      SELECT "signature" INTO v_previa
        FROM "stock_reconciliation_alert" WHERE "distributor_id" = p_distribuidora;
      -- La misma diferencia de anoche no se vuelve a avisar.
      p_avisar := v_previa IS DISTINCT FROM p_firma;
    ELSE
      p_firma := NULL;
      p_avisar := false;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    v_sqlstate := SQLSTATE;
  END;

  -- Escritura (cuerpo principal): si cierra, la alerta vigente se borra para que el
  -- próximo desvío avise de nuevo.
  IF v_error IS NULL AND p_consistente THEN
    DELETE FROM "stock_reconciliation_alert" WHERE "distributor_id" = p_distribuidora;
    BEGIN
      IF EXISTS (SELECT 1 FROM "stock_reconciliation_alert" WHERE "distributor_id" = p_distribuidora) THEN
        RAISE EXCEPTION 'la alerta de % sigue vigente después de borrarla', p_distribuidora;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      v_sqlstate := SQLSTATE;
    END;
  END IF;

  IF v_error IS NOT NULL THEN
    ROLLBACK;
    RAISE EXCEPTION 'conciliar_stock_del_dia falló: %', v_error USING ERRCODE = v_sqlstate;
  END IF;
  IF NOT p_consistente THEN
    RAISE NOTICE 'Conciliación de stock de %: hay diferencias (aviso: %)', p_distribuidora, p_avisar;
  END IF;
  COMMIT;
END;
$$`;

export const CREAR_VERIFICAR_SALDOS_DE_CAJA = `
CREATE PROCEDURE verificar_saldos_de_caja(
  p_distribuidora uuid,
  INOUT p_desfasadas integer DEFAULT NULL,
  INOUT p_detalle jsonb DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_error text;
  v_sqlstate text;
  v_cajas jsonb;
  v_cuentas jsonb;
BEGIN
  IF p_distribuidora IS NULL
     OR NOT EXISTS (SELECT 1 FROM "distributor" WHERE "distributor_id" = p_distribuidora) THEN
    RAISE EXCEPTION 'verificar_saldos_de_caja: la distribuidora % no existe', p_distribuidora
      USING ERRCODE = 'no_data_found';
  END IF;

  COMMIT;
  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

  -- Sólo lee: el bloque captura el error.
  BEGIN
    -- Cada caja: el saldo guardado contra la suma de sus movimientos.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'tipo', 'caja', 'id', t."cash_box_id", 'saldo', t."balance"::text, 'libro', t."libro"::text
           ) ORDER BY t."cash_box_id"), '[]'::jsonb)
      INTO v_cajas
      FROM (
        SELECT b."cash_box_id", b."balance",
               COALESCE(SUM(CASE WHEN m."direction" = 'in' THEN m."amount" ELSE -m."amount" END), 0) AS "libro"
          FROM "cash_box" b LEFT JOIN "cash_movement" m ON m."cash_box_id" = b."cash_box_id"
         WHERE b."distributor_id" = p_distribuidora
         GROUP BY b."cash_box_id", b."balance"
        HAVING b."balance" <> COALESCE(SUM(CASE WHEN m."direction" = 'in' THEN m."amount" ELSE -m."amount" END), 0)
      ) t;

    -- Cada cuenta corriente: el saldo guardado contra la suma de su libro.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'tipo', 'cuenta', 'id', t."account_id", 'saldo', t."balance"::text, 'libro', t."libro"::text
           ) ORDER BY t."account_id"), '[]'::jsonb)
      INTO v_cuentas
      FROM (
        SELECT a."account_id", a."balance",
               COALESCE(SUM(CASE WHEN e."type" IN ('sale_charge', 'debit_note') THEN e."amount" ELSE -e."amount" END), 0) AS "libro"
          FROM "customer_account" a LEFT JOIN "customer_account_entry" e ON e."account_id" = a."account_id"
         WHERE a."distributor_id" = p_distribuidora
         GROUP BY a."account_id", a."balance"
        HAVING a."balance" <> COALESCE(SUM(CASE WHEN e."type" IN ('sale_charge', 'debit_note') THEN e."amount" ELSE -e."amount" END), 0)
      ) t;

    p_detalle := v_cajas || v_cuentas;
    p_desfasadas := jsonb_array_length(p_detalle);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    v_sqlstate := SQLSTATE;
  END;

  IF v_error IS NOT NULL THEN
    ROLLBACK;
    RAISE EXCEPTION 'verificar_saldos_de_caja falló: %', v_error USING ERRCODE = v_sqlstate;
  END IF;
  IF p_desfasadas > 0 THEN
    RAISE NOTICE 'Distribuidora %: % saldo(s) desfasado(s)', p_distribuidora, p_desfasadas;
  END IF;
  COMMIT;
END;
$$`;

export const CREAR_PROCEDIMIENTOS_DE_CONCILIACION = [
  CREAR_CONCILIAR_STOCK_DEL_DIA,
  CREAR_VERIFICAR_SALDOS_DE_CAJA,
];

export const BORRAR_PROCEDIMIENTOS_DE_CONCILIACION = [
  'DROP PROCEDURE IF EXISTS verificar_saldos_de_caja(uuid, integer, jsonb)',
  'DROP PROCEDURE IF EXISTS conciliar_stock_del_dia(uuid, boolean, boolean, text, jsonb)',
];
