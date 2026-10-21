-- Verifica que la BASE rechaza lo que el back también rechaza (tanda V1 de validaciones).
--
-- Corre contra splg_db dentro de una transacción que termina en ROLLBACK: no deja nada.
--   docker exec -i splg-bd psql -U postgres -d splg_db -v ON_ERROR_STOP=1 < scripts/verificar-constraints.sql
--
-- Cada caso intenta una escritura inválida y comprueba que falla CON LA RESTRICCIÓN
-- ESPERADA (por nombre), no con cualquier error. (El caso de `CHK_order_total_formula`
-- se saltea mientras esa migración esté pendiente.) Los CHECK se prueban sobre una
-- tabla temporal con las mismas restricciones (LIKE ... INCLUDING CONSTRAINTS), así
-- también vale con las tablas vacías; los índices únicos, las exclusiones y las
-- claves foráneas se prueban sobre las tablas reales. Al final, si algún caso falló,
-- aborta con la lista.

BEGIN;

CREATE TEMP TABLE resultado (orden serial, caso text, ok boolean, detalle text) ON COMMIT DROP;

-- Fila válida para una tabla: lo obligatorio sin valor por defecto, con un valor neutro;
-- encima, los cambios del caso.
CREATE FUNCTION pg_temp.fila_base(p_tabla text, p_cambios jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE c record; j jsonb := '{}'; v jsonb;
BEGIN
  FOR c IN SELECT column_name, data_type, udt_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = p_tabla
              AND is_nullable = 'NO' AND column_default IS NULL LOOP
    v := CASE
      WHEN c.data_type = 'uuid' THEN to_jsonb(gen_random_uuid()::text)
      WHEN c.data_type IN ('character varying', 'text') THEN to_jsonb('x'::text)
      WHEN c.data_type IN ('integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real') THEN to_jsonb(1)
      WHEN c.data_type = 'boolean' THEN to_jsonb(false)
      WHEN c.data_type = 'timestamp with time zone' THEN to_jsonb('2026-10-21T12:00:00Z'::text)
      WHEN c.data_type = 'date' THEN to_jsonb('2026-10-21'::text)
      WHEN c.data_type = 'time without time zone' THEN to_jsonb('08:00'::text)
      WHEN c.data_type = 'jsonb' THEN '{}'::jsonb
      WHEN c.data_type = 'USER-DEFINED' AND c.udt_name IN ('geometry', 'geography') THEN to_jsonb('SRID=4326;POINT(0 0)'::text)
      WHEN c.data_type = 'USER-DEFINED' THEN to_jsonb((SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                                      WHERE t.typname = c.udt_name ORDER BY e.enumsortorder LIMIT 1))
    END;
    j := j || jsonb_build_object(c.column_name, v);
  END LOOP;
  RETURN j || p_cambios;
END $f$;

CREATE FUNCTION pg_temp.insertar_en_temporal(p_tabla text, p_fila jsonb) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE format('CREATE TEMP TABLE IF NOT EXISTS %I (LIKE public.%I INCLUDING CONSTRAINTS INCLUDING DEFAULTS)', 't_' || p_tabla, p_tabla);
  -- Sólo las columnas del caso: el resto toma su valor por defecto (la clave primaria, por ejemplo).
  EXECUTE format('INSERT INTO pg_temp.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, %L::jsonb)',
                 't_' || p_tabla,
                 (SELECT string_agg(quote_ident(k), ', ') FROM jsonb_object_keys(p_fila) AS k),
                 (SELECT string_agg(quote_ident(k), ', ') FROM jsonb_object_keys(p_fila) AS k),
                 p_tabla, p_fila::text);
END $f$;

-- La base tiene que rechazar la fila con la restricción `p_esperada`.
CREATE FUNCTION pg_temp.rechaza(p_tabla text, p_esperada text, p_arreglo jsonb, p_cambios jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_caso text := p_tabla || ' · ' || p_esperada || ' · ' || (p_cambios::text);
        v_nombre text; v_estado text; v_msg text;
BEGIN
  BEGIN
    PERFORM pg_temp.insertar_en_temporal(p_tabla, pg_temp.fila_base(p_tabla, p_arreglo || p_cambios));
    INSERT INTO resultado (caso, ok, detalle) VALUES (v_caso, false, 'la base ACEPTÓ la fila inválida');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_nombre = CONSTRAINT_NAME, v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_nombre = p_esperada THEN
      INSERT INTO resultado (caso, ok, detalle) VALUES (v_caso, true, v_estado);
    ELSE
      INSERT INTO resultado (caso, ok, detalle) VALUES (v_caso, false, format('falló con %s (%s): %s', coalesce(v_nombre, '?'), v_estado, v_msg));
    END IF;
  END;
END $f$;

-- La base tiene que aceptar la fila.
CREATE FUNCTION pg_temp.acepta(p_tabla text, p_caso text, p_arreglo jsonb, p_cambios jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_msg text;
BEGIN
  BEGIN
    PERFORM pg_temp.insertar_en_temporal(p_tabla, pg_temp.fila_base(p_tabla, p_arreglo || p_cambios));
    INSERT INTO resultado (caso, ok, detalle) VALUES ('acepta · ' || p_tabla || ' · ' || p_caso, true, 'ok');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    INSERT INTO resultado (caso, ok, detalle) VALUES ('acepta · ' || p_tabla || ' · ' || p_caso, false, 'la base RECHAZÓ una fila válida: ' || v_msg);
  END;
END $f$;

-- Sentencias sobre las tablas reales: tiene que fallar con la restricción `p_esperada`.
CREATE FUNCTION pg_temp.falla_con(p_caso text, p_sql text, p_esperada text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_nombre text; v_estado text; v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO resultado (caso, ok, detalle) VALUES (p_caso, false, 'la base ACEPTÓ la sentencia inválida');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_nombre = CONSTRAINT_NAME, v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_nombre = p_esperada OR p_esperada = 'SQLSTATE:' || v_estado THEN
      INSERT INTO resultado (caso, ok, detalle) VALUES (p_caso, true, v_estado);
    ELSE
      INSERT INTO resultado (caso, ok, detalle) VALUES (p_caso, false, format('falló con %s (%s): %s', coalesce(v_nombre, '?'), v_estado, v_msg));
    END IF;
  END;
END $f$;

-- Sentencias sobre las tablas reales que tienen que funcionar.
CREATE FUNCTION pg_temp.funciona(p_caso text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO resultado (caso, ok, detalle) VALUES ('acepta · ' || p_caso, true, 'ok');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    INSERT INTO resultado (caso, ok, detalle) VALUES ('acepta · ' || p_caso, false, 'la base RECHAZÓ algo válido: ' || v_msg);
  END;
END $f$;

CREATE FUNCTION pg_temp.afirma(p_caso text, p_condicion boolean) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO resultado (caso, ok, detalle) VALUES (p_caso, coalesce(p_condicion, false), CASE WHEN coalesce(p_condicion, false) THEN 'ok' ELSE 'no se cumple' END)
$f$;

-- ---------------------------------------------------------------------------
-- 1. CHECK: cada regla rechaza su caso inválido
-- ---------------------------------------------------------------------------

SELECT pg_temp.rechaza('order', 'CHK_order_montos', '{}'::jsonb, '{"totalAmount": -1, "subtotal_items": -1}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_total_formula', '{}'::jsonb, '{"totalAmount": 5}'::jsonb) WHERE EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_order_total_formula');
SELECT pg_temp.rechaza('order', 'CHK_order_pago_coherente', '{}'::jsonb, '{"paymentMethod": "cash", "paymentType": "online"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_pago_coherente', '{}'::jsonb, '{"paymentMethod": "mercadopago", "paymentType": "cash"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_pago_coherente', '{}'::jsonb, '{"paymentMethod": "account", "paymentType": "online"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_aceptado_fecha', '{}'::jsonb, '{"status": "accepted", "delivery_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_en_camino_fecha', '{}'::jsonb, '{"status": "on_the_way", "acceptedAt": "2026-10-21T12:00:00Z", "delivery_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_entregado_fecha', '{}'::jsonb, '{"status": "pending", "deliveredAt": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_chofer_asignado', '{}'::jsonb, '{"status": "accepted", "acceptedAt": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_cancelado_motivo', '{}'::jsonb, '{"status": "cancelled"}'::jsonb);
SELECT pg_temp.rechaza('order', 'CHK_order_cancelado_motivo', '{}'::jsonb, '{"status": "cancelled", "cancellationReason": "   "}'::jsonb);
SELECT pg_temp.rechaza('order_item', 'CHK_order_item_cantidad', '{}'::jsonb, '{"quantity": 0}'::jsonb);
SELECT pg_temp.rechaza('order_item', 'CHK_order_item_importes', '{}'::jsonb, '{"unitPrice": -1}'::jsonb);
SELECT pg_temp.rechaza('cart_item', 'CHK_cart_item_cantidad', '{}'::jsonb, '{"quantity": 0}'::jsonb);
SELECT pg_temp.rechaza('cart_item', 'CHK_cart_item_cantidad', '{}'::jsonb, '{"quantity": 1000}'::jsonb);
SELECT pg_temp.rechaza('cart_item', 'CHK_cart_item_precio', '{}'::jsonb, '{"unit_price": -1}'::jsonb);
SELECT pg_temp.rechaza('payment', 'CHK_payment_importe', '{}'::jsonb, '{"amount": 0}'::jsonb);
SELECT pg_temp.rechaza('payment_refund', 'CHK_payment_refund_importe', '{}'::jsonb, '{"amount": 0}'::jsonb);
SELECT pg_temp.rechaza('payment_refund', 'CHK_payment_refund_intentos', '{}'::jsonb, '{"attempts": -1}'::jsonb);
SELECT pg_temp.rechaza('payment_refund', 'CHK_payment_refund_exito_fecha', '{}'::jsonb, '{"status": "succeeded"}'::jsonb);
SELECT pg_temp.rechaza('cash_session', 'CHK_cash_session_montos', '{"opening_amount": 0}'::jsonb, '{"opening_amount": -1}'::jsonb);
SELECT pg_temp.rechaza('cash_session', 'CHK_cash_session_cierre_fecha', '{"opening_amount": 0}'::jsonb, '{"status": "open", "closed_at": "2026-10-22T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('cash_session', 'CHK_cash_session_cierre_completo', '{"opening_amount": 0}'::jsonb, '{"status": "closed", "closed_at": "2026-10-22T12:00:00Z", "closed_by_user_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
SELECT pg_temp.rechaza('cash_session', 'CHK_cash_session_periodo', '{"opening_amount": 0}'::jsonb, '{"status": "closed", "closed_at": "2026-10-20T12:00:00Z", "closed_by_user_id": "11111111-1111-1111-1111-111111111111", "counted_amount": 5, "expected_amount": 5, "difference": 0}'::jsonb);
SELECT pg_temp.rechaza('customer_account', 'CHK_customer_account_plazo_maximo', '{}'::jsonb, '{"payment_terms_days": 366}'::jsonb);
SELECT pg_temp.rechaza('customer_account', 'CHK_customer_account_cerrada_sin_saldo', '{}'::jsonb, '{"status": "closed", "balance": 5}'::jsonb);
SELECT pg_temp.rechaza('customer_account', 'CHK_customer_account_cuit', '{}'::jsonb, '{"tax_id": "30712345670"}'::jsonb);
SELECT pg_temp.rechaza('customer_account_entry', 'CHK_customer_account_entry_vencimiento', '{}'::jsonb, '{"occurred_at": "2026-10-21T12:00:00Z", "due_date": "2026-10-01"}'::jsonb);
SELECT pg_temp.rechaza('driver_settlement', 'CHK_driver_settlement_montos', '{}'::jsonb, '{"expected_cash": -1}'::jsonb);
SELECT pg_temp.rechaza('driver_settlement', 'CHK_driver_settlement_presentada', '{}'::jsonb, '{"status": "submitted"}'::jsonb);
SELECT pg_temp.rechaza('driver_settlement', 'CHK_driver_settlement_aprobada', '{}'::jsonb, '{"status": "open", "approved_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('driver_settlement', 'CHK_driver_settlement_diferencia', '{}'::jsonb, '{"declared_cash": 1, "difference": 5}'::jsonb);
SELECT pg_temp.rechaza('driver_settlement_order', 'CHK_driver_settlement_order_importe', '{}'::jsonb, '{"amount": -1}'::jsonb);
SELECT pg_temp.rechaza('driver_settlement_collection', 'CHK_driver_settlement_collection_importe', '{}'::jsonb, '{"amount": 0}'::jsonb);
SELECT pg_temp.rechaza('driver_liquidation', 'CHK_driver_liquidation_periodo', '{"gross": 1, "deductions": 0, "net": 1}'::jsonb, '{"period_from": "2026-02-01", "period_to": "2026-01-01"}'::jsonb);
SELECT pg_temp.rechaza('driver_liquidation', 'CHK_driver_liquidation_montos', '{"gross": 1, "deductions": 0, "net": 1}'::jsonb, '{"net": 5}'::jsonb);
SELECT pg_temp.rechaza('driver_liquidation', 'CHK_driver_liquidation_aprobada', '{"gross": 1, "deductions": 0, "net": 1}'::jsonb, '{"status": "approved"}'::jsonb);
SELECT pg_temp.rechaza('driver_liquidation', 'CHK_driver_liquidation_pagada', '{"gross": 1, "deductions": 0, "net": 1}'::jsonb, '{"status": "paid", "approved_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('driver_liquidation', 'CHK_driver_liquidation_anulada', '{"gross": 1, "deductions": 0, "net": 1}'::jsonb, '{"status": "voided"}'::jsonb);
SELECT pg_temp.rechaza('commission_rule', 'CHK_commission_rule_porcentaje', '{}'::jsonb, '{"basis": "percent_of_total", "value": 101}'::jsonb);
SELECT pg_temp.rechaza('commission_entry', 'CHK_commission_entry_importe', '{}'::jsonb, '{"amount": 0}'::jsonb);
SELECT pg_temp.rechaza('commission_entry', 'CHK_commission_entry_signo', '{}'::jsonb, '{"type": "delivery_commission", "amount": -5}'::jsonb);
SELECT pg_temp.rechaza('commission_entry', 'CHK_commission_entry_signo', '{}'::jsonb, '{"type": "settlement_shortage", "amount": 5}'::jsonb);
SELECT pg_temp.rechaza('gas_cylinder', 'CHK_gas_cylinder_valores', '{}'::jsonb, '{"price": 0}'::jsonb);
SELECT pg_temp.rechaza('gas_cylinder', 'CHK_gas_cylinder_valores', '{}'::jsonb, '{"weight": 0}'::jsonb);
SELECT pg_temp.rechaza('gas_cylinder', 'CHK_gas_cylinder_valores', '{}'::jsonb, '{"stock": -1}'::jsonb);
SELECT pg_temp.rechaza('gas_cylinder', 'CHK_gas_cylinder_tipo', '{}'::jsonb, '{"type": "  "}'::jsonb);
SELECT pg_temp.rechaza('gas_cylinder_promotion', 'CHK_promocion_descuento', '{"quantity": 2, "discount_percentage": 10}'::jsonb, '{"quantity": 2, "discount_percentage": 100}'::jsonb);
SELECT pg_temp.rechaza('cylinder', 'CHK_cylinder_garantia', '{"state": "in_depot"}'::jsonb, '{"deposit": -1}'::jsonb);
SELECT pg_temp.rechaza('cylinder', 'CHK_cylinder_cliente_segun_estado', '{"state": "in_depot"}'::jsonb, '{"state": "in_depot", "current_customer_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
SELECT pg_temp.rechaza('cylinder', 'CHK_cylinder_cliente_segun_estado', '{"state": "in_depot"}'::jsonb, '{"state": "with_customer"}'::jsonb);
SELECT pg_temp.rechaza('cylinder', 'CHK_cylinder_vencimiento', '{"state": "in_depot"}'::jsonb, '{"manufactured_at": "2026-10-21T12:00:00Z", "expires_at": "2026-10-20T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('cylinder', 'CHK_cylinder_serial', '{"state": "in_depot"}'::jsonb, '{"serial": "  "}'::jsonb);
SELECT pg_temp.rechaza('cylinder_movement', 'CHK_cylinder_movement_cambio', '{}'::jsonb, '{"from_state": "in_depot", "to_state": "in_depot"}'::jsonb);
SELECT pg_temp.rechaza('cylinder_inspection', 'CHK_cylinder_inspection_vencimiento', '{"result": "approved", "inspected_at": "2026-10-20T12:00:00Z", "next_due_at": "2026-10-21T12:00:00Z"}'::jsonb, '{"inspected_at": "2026-10-21T12:00:00Z", "next_due_at": "2026-10-20T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('cylinder_inspection', 'CHK_cylinder_inspection_proxima', '{"result": "approved", "inspected_at": "2026-10-20T12:00:00Z", "next_due_at": "2026-10-21T12:00:00Z"}'::jsonb, '{"result": "approved", "next_due_at": null}'::jsonb);
SELECT pg_temp.rechaza('stock_movement', 'CHK_stock_movement_origen_destino_distintos', '{}'::jsonb, '{"from_location_id": "11111111-1111-1111-1111-111111111111", "to_location_id": "11111111-1111-1111-1111-111111111111", "from_condition": "full", "to_condition": "full"}'::jsonb);
SELECT pg_temp.rechaza('stock_adjustment', 'CHK_stock_adjustment_notas', '{}'::jsonb, '{"notes": "  "}'::jsonb);
SELECT pg_temp.rechaza('purchase_order', 'CHK_purchase_order_cancelada', '{"total_amount": 0}'::jsonb, '{"status": "cancelled"}'::jsonb);
SELECT pg_temp.rechaza('purchase_order', 'CHK_purchase_order_cerrada_corta', '{"total_amount": 0}'::jsonb, '{"status": "closed_short", "issued_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('purchase_order', 'CHK_purchase_order_emitida', '{"total_amount": 0}'::jsonb, '{"status": "sent"}'::jsonb);
SELECT pg_temp.rechaza('purchase_order', 'CHK_purchase_order_total', '{"total_amount": 0}'::jsonb, '{"total_amount": -1}'::jsonb);
SELECT pg_temp.rechaza('purchase_receipt', 'CHK_purchase_receipt_total', '{"total_amount": 0}'::jsonb, '{"total_amount": -1}'::jsonb);
SELECT pg_temp.rechaza('purchase_receipt', 'CHK_purchase_receipt_anulada_fecha', '{"total_amount": 0}'::jsonb, '{"status": "confirmed", "voided_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('purchase_receipt', 'CHK_purchase_receipt_anulacion_datos', '{"total_amount": 0}'::jsonb, '{"status": "voided", "voided_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('supplier', 'CHK_supplier_cuit', '{"cuit": "30712345671"}'::jsonb, '{"cuit": "30712345670"}'::jsonb);
SELECT pg_temp.rechaza('supplier', 'CHK_supplier_cuit', '{"cuit": "30712345671"}'::jsonb, '{"cuit": "12345678901"}'::jsonb);
SELECT pg_temp.rechaza('truck_load', 'CHK_truck_load_salida', '{}'::jsonb, '{"status": "on_route"}'::jsonb);
SELECT pg_temp.rechaza('truck_load', 'CHK_truck_load_regreso', '{}'::jsonb, '{"status": "returned", "departed_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('truck_load', 'CHK_truck_load_cierre', '{}'::jsonb, '{"status": "closed", "departed_at": "2026-10-21T12:00:00Z", "returned_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('truck_load', 'CHK_truck_load_cancelada', '{}'::jsonb, '{"status": "cancelled", "closed_at": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('traffic_fine', 'CHK_traffic_fine_pago_voluntario', '{}'::jsonb, '{"voluntary_payment_amount": 5}'::jsonb);
SELECT pg_temp.rechaza('traffic_fine', 'CHK_traffic_fine_importe_pagado', '{}'::jsonb, '{"paid_amount": 0}'::jsonb);
SELECT pg_temp.rechaza('traffic_fine', 'CHK_traffic_fine_pagada_datos', '{}'::jsonb, '{"status": "paid"}'::jsonb);
SELECT pg_temp.rechaza('traffic_fine', 'CHK_traffic_fine_anulada_fecha', '{}'::jsonb, '{"status": "voided"}'::jsonb);
SELECT pg_temp.rechaza('fuel_load', 'CHK_fuel_load_precio', '{}'::jsonb, '{"unit_price": 0}'::jsonb);
SELECT pg_temp.rechaza('fuel_load', 'CHK_fuel_load_odometro', '{}'::jsonb, '{"odometer_km": -1}'::jsonb);
SELECT pg_temp.rechaza('vehicle_accident', 'CHK_vehicle_accident_montos', '{}'::jsonb, '{"repair_cost": -1}'::jsonb);
SELECT pg_temp.rechaza('vehicle_accident', 'CHK_vehicle_accident_montos', '{}'::jsonb, '{"repair_cost": 5, "insurer_reimbursement": 10}'::jsonb);
SELECT pg_temp.rechaza('vehicle_accident', 'CHK_vehicle_accident_cerrado_fecha', '{}'::jsonb, '{"status": "closed"}'::jsonb);
SELECT pg_temp.rechaza('maintenance_task', 'CHK_maintenance_task_valores', '{"car_id": "22222222-2222-2222-2222-222222222222"}'::jsonb, '{"car_id": "11111111-1111-1111-1111-111111111111", "cost": -1}'::jsonb);
SELECT pg_temp.rechaza('maintenance_task', 'CHK_maintenance_task_un_sujeto', '{"car_id": "22222222-2222-2222-2222-222222222222"}'::jsonb, '{"car_id": "11111111-1111-1111-1111-111111111111", "delivery_id": "22222222-2222-2222-2222-222222222222"}'::jsonb);
SELECT pg_temp.rechaza('maintenance_task', 'CHK_maintenance_task_un_sujeto', '{"car_id": "22222222-2222-2222-2222-222222222222"}'::jsonb, '{"car_id": null}'::jsonb);
SELECT pg_temp.rechaza('maintenance_task', 'CHK_maintenance_task_hecha_fecha', '{"car_id": "22222222-2222-2222-2222-222222222222"}'::jsonb, '{"car_id": "11111111-1111-1111-1111-111111111111", "status": "done"}'::jsonb);
SELECT pg_temp.rechaza('tire', 'CHK_tire_valores', '{}'::jsonb, '{"cost": -1}'::jsonb);
SELECT pg_temp.rechaza('tire', 'CHK_tire_montaje', '{}'::jsonb, '{"status": "mounted"}'::jsonb);
SELECT pg_temp.rechaza('vehicle_usage_log', 'CHK_vehicle_usage_log_valores', '{}'::jsonb, '{"km": -1}'::jsonb);
SELECT pg_temp.rechaza('vehicle_assignment', 'CHK_vehicle_assignment_periodo', '{}'::jsonb, '{"assigned_at": "2026-10-21T12:00:00Z", "released_at": "2026-10-20T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('car', 'CHK_car_patente', '{"car_patent": "AB123CD"}'::jsonb, '{"car_patent": "abc"}'::jsonb);
SELECT pg_temp.rechaza('car', 'CHK_car_patente', '{"car_patent": "AB123CD"}'::jsonb, '{"car_patent": "AB 123"}'::jsonb);
SELECT pg_temp.rechaza('car', 'CHK_car_patente', '{"car_patent": "AB123CD"}'::jsonb, '{"car_patent": "ABCD123"}'::jsonb);
SELECT pg_temp.rechaza('delivery', 'CHK_delivery_calificacion', '{}'::jsonb, '{"calification": 6}'::jsonb);
SELECT pg_temp.rechaza('customer', 'CHK_customer_consumo', '{}'::jsonb, '{"avg_monthly_consumption_kg": 0}'::jsonb);
SELECT pg_temp.rechaza('employee', 'CHK_employee_nacimiento', '{}'::jsonb, '{"birth_date": "2026-02-01", "hire_date": "2026-01-01"}'::jsonb);
SELECT pg_temp.rechaza('employee', 'CHK_employee_cuil', '{}'::jsonb, '{"cuil": "20123456780"}'::jsonb);
SELECT pg_temp.rechaza('employee', 'CHK_employee_email', '{}'::jsonb, '{"personal_email": "sin-arroba"}'::jsonb);
SELECT pg_temp.rechaza('employee', 'CHK_employee_cbu', '{}'::jsonb, '{"bank_cbu": "123"}'::jsonb);
SELECT pg_temp.rechaza('user', 'CHK_user_telefono', '{}'::jsonb, '{"phone_number": "3764000000"}'::jsonb);
SELECT pg_temp.rechaza('user', 'CHK_user_email', '{}'::jsonb, '{"email": "sin-arroba"}'::jsonb);
SELECT pg_temp.rechaza('rating', 'CHK_rating_valores', '{}'::jsonb, '{"stars": 6}'::jsonb);
SELECT pg_temp.rechaza('rating', 'CHK_rating_valores', '{}'::jsonb, '{"stars": 0}'::jsonb);
SELECT pg_temp.rechaza('rating', 'CHK_rating_valores', '{}'::jsonb, '{"from_user_id": "11111111-1111-1111-1111-111111111111", "to_user_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
SELECT pg_temp.rechaza('rating', 'CHK_rating_valores', '{}'::jsonb, '{"hidden": true}'::jsonb);
SELECT pg_temp.rechaza('time_slot', 'CHK_time_slot_horario', '{"startTime": "09:00", "endTime": "10:00"}'::jsonb, '{"startTime": "10:00", "endTime": "09:00"}'::jsonb);
SELECT pg_temp.rechaza('time_slot', 'CHK_time_slot_horario', '{"startTime": "09:00", "endTime": "10:00"}'::jsonb, '{"startTime": "10:00", "endTime": "10:00"}'::jsonb);
SELECT pg_temp.rechaza('time_slot', 'CHK_time_slot_capacidad', '{"startTime": "09:00", "endTime": "10:00"}'::jsonb, '{"capacity": 0}'::jsonb);
SELECT pg_temp.rechaza('coverage_zone', 'CHK_coverage_zone_vigencia', '{"area": "SRID=4326;POLYGON((0 0,1 0,1 1,0 0))", "surcharge_type": "fixed", "surcharge_value": 0}'::jsonb, '{"valid_from": "2026-10-21T12:00:00Z", "valid_until": "2026-10-20T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('route_batch_stop', 'CHK_route_batch_stop_secuencia', '{}'::jsonb, '{"sequence": 0}'::jsonb);
SELECT pg_temp.rechaza('order_dispatch_offer', 'CHK_order_dispatch_offer_vencimiento', '{"offeredAt": "2026-10-21T12:00:00Z", "expiresAt": "2026-10-22T12:00:00Z"}'::jsonb, '{"offeredAt": "2026-10-21T12:00:00Z", "expiresAt": "2026-10-21T12:00:00Z"}'::jsonb);
SELECT pg_temp.rechaza('document_sequence', 'CHK_document_sequence_valores', '{"doc_type": "pedido", "last_number": 0}'::jsonb, '{"last_number": -1}'::jsonb);
SELECT pg_temp.rechaza('document_sequence', 'CHK_document_sequence_valores', '{"doc_type": "pedido", "last_number": 0}'::jsonb, '{"doc_type": "A"}'::jsonb);
SELECT pg_temp.rechaza('distributor', 'CHK_distributor_cuit', '{"slug": "demo-x"}'::jsonb, '{"tax_id": "30-12345678-9"}'::jsonb);
SELECT pg_temp.rechaza('distributor', 'CHK_distributor_slug', '{"slug": "demo-x"}'::jsonb, '{"slug": "Demo Uno"}'::jsonb);
SELECT pg_temp.rechaza('warehouse', 'CHK_warehouse_codigo', '{"code": "DEP-1"}'::jsonb, '{"code": "abc"}'::jsonb);
SELECT pg_temp.rechaza('claims', 'CHK_claims_textos', '{}'::jsonb, '{"reason": "  "}'::jsonb);
SELECT pg_temp.rechaza('incident', 'CHK_incident_descripcion', '{}'::jsonb, '{"description": "  "}'::jsonb);

-- Casos válidos que tienen que seguir pasando

SELECT pg_temp.acepta('order', 'pedido online con recargo', '{}'::jsonb, '{"paymentMethod": "mercadopago", "paymentType": "online", "totalAmount": 110, "subtotal_items": 100, "payment_surcharge_amount": 10}'::jsonb);
SELECT pg_temp.acepta('order', 'pedido express degradado: el total ya no lleva el express', '{}'::jsonb, '{"subtotal_items": 100, "express_surcharge_amount": 1500, "express_degraded_at": "2026-10-21T12:00:00Z", "totalAmount": 100}'::jsonb);
SELECT pg_temp.acepta('order', 'pedido entregado completo', '{}'::jsonb, '{"status": "delivered", "acceptedAt": "2026-10-20T12:00:00Z", "onTheWayAt": "2026-10-20T12:00:00Z", "deliveredAt": "2026-10-21T12:00:00Z", "delivery_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
SELECT pg_temp.acepta('order', 'pedido cancelado con motivo', '{}'::jsonb, '{"status": "cancelled", "cancellationReason": "El cliente no estaba"}'::jsonb);
SELECT pg_temp.acepta('cylinder_movement', 'anotación del historial: mismo estado pero con nota', '{}'::jsonb, '{"from_state": "dispatched", "to_state": "dispatched", "note": "Revisión rechazada"}'::jsonb);
SELECT pg_temp.acepta('gas_cylinder_promotion', 'promoción del 99 %', '{"quantity": 2, "discount_percentage": 10}'::jsonb, '{"quantity": 2, "discount_percentage": 99}'::jsonb);
SELECT pg_temp.acepta('car', 'patente Mercosur', '{"car_patent": "AB123CD"}'::jsonb, '{"car_patent": "AB123CD"}'::jsonb);
SELECT pg_temp.acepta('car', 'patente anterior', '{"car_patent": "AB123CD"}'::jsonb, '{"car_patent": "ABC123"}'::jsonb);
SELECT pg_temp.acepta('time_slot', 'franja 9 a 10', '{"startTime": "09:00", "endTime": "10:00"}'::jsonb, '{"startTime": "09:00", "endTime": "10:00"}'::jsonb);
SELECT pg_temp.acepta('supplier', 'CUIT con dígito verificador correcto', '{"cuit": "30712345671"}'::jsonb, '{"cuit": "30712345671"}'::jsonb);
SELECT pg_temp.acepta('user', 'teléfono E.164', '{}'::jsonb, '{"phone_number": "+5493764000000", "email": "ana@correo.com"}'::jsonb);

-- ---------------------------------------------------------------------------
-- 2. Índices únicos y exclusiones, sobre las tablas reales
-- ---------------------------------------------------------------------------

-- Correo sin distinguir mayúsculas.
SELECT pg_temp.falla_con('user · correo repetido en mayúsculas',
  $s$ INSERT INTO "user" (user_id, email) SELECT gen_random_uuid(), upper(email) FROM "user" WHERE email IS NOT NULL LIMIT 1 $s$,
  'UQ_user_email_minusculas');

-- Patente única por distribuidora (y vigente).
SELECT pg_temp.falla_con('car · patente repetida en la misma distribuidora',
  $s$ INSERT INTO car (distributor_id, user_id, car_patent) SELECT distributor_id, user_id, car_patent FROM car WHERE "deletedAt" IS NULL AND car_patent IS NOT NULL LIMIT 1 $s$,
  'UQ_car_patente_distribuidora_vigente');
SELECT pg_temp.funciona('car · la misma patente en OTRA distribuidora',
  $s$ INSERT INTO car (distributor_id, user_id, car_patent)
       SELECT (SELECT distributor_id FROM distributor d WHERE d.distributor_id <> c.distributor_id LIMIT 1), c.user_id, c.car_patent
         FROM car c WHERE c."deletedAt" IS NULL AND c.car_patent IS NOT NULL LIMIT 1 $s$);
SELECT pg_temp.funciona('car · la patente de un vehículo dado de baja se puede volver a registrar',
  $s$ WITH baja AS (UPDATE car SET "deletedAt" = now() WHERE car_id = (SELECT car_id FROM car WHERE "deletedAt" IS NULL AND car_patent IS NOT NULL LIMIT 1) RETURNING distributor_id, user_id, car_patent)
      INSERT INTO car (distributor_id, user_id, car_patent) SELECT * FROM baja $s$);

-- Una dirección principal por usuario.
SELECT pg_temp.falla_con('user_address · dos principales del mismo usuario',
  $s$ INSERT INTO user_address (user_id, street, city, "isDefault") SELECT user_id, 'x', 'x', true FROM user_address WHERE "isDefault" AND "deletedAt" IS NULL LIMIT 1 $s$,
  'UQ_user_address_principal');

-- Ofertas de despacho.
SELECT pg_temp.falla_con('order_dispatch_offer · dos ofertas vivas del mismo pedido para el mismo chofer',
  $s$ INSERT INTO order_dispatch_offer (distributor_id, order_id, driver_id, status, "expiresAt")
        SELECT distributor_id, order_id, driver_id, 'offered', now() + interval '1 hour' FROM order_dispatch_offer LIMIT 1;
      INSERT INTO order_dispatch_offer (distributor_id, order_id, driver_id, status, "expiresAt")
        SELECT distributor_id, order_id, driver_id, 'offered', now() + interval '1 hour' FROM order_dispatch_offer WHERE status = 'offered' ORDER BY "offeredAt" DESC LIMIT 1 $s$,
  'UQ_order_dispatch_offer_viva');
SELECT pg_temp.falla_con('order_dispatch_offer · dos ofertas aceptadas del mismo pedido',
  $s$ INSERT INTO order_dispatch_offer (distributor_id, order_id, driver_id, status, "expiresAt")
        SELECT distributor_id, order_id, driver_id, 'accepted', now() + interval '1 hour' FROM order_dispatch_offer LIMIT 1;
      INSERT INTO order_dispatch_offer (distributor_id, order_id, driver_id, status, "expiresAt")
        SELECT distributor_id, order_id, gen_random_uuid(), 'accepted', now() + interval '1 hour' FROM order_dispatch_offer WHERE status = 'accepted' ORDER BY "offeredAt" DESC LIMIT 1 $s$,
  'UQ_order_dispatch_offer_aceptada');

-- Una garrafa por renglón.
SELECT pg_temp.falla_con('order_item · la misma garrafa dos veces en el pedido',
  $s$ INSERT INTO order_item (order_id, gas_cylinder_id, quantity, "unitPrice", subtotal) SELECT order_id, gas_cylinder_id, 1, 1, 1 FROM order_item LIMIT 1 $s$,
  'UQ_order_item_pedido_producto');

-- Franjas: nombre único entre activas y sin solaparse.
SELECT pg_temp.falla_con('time_slot · mismo nombre entre activas (horario libre)',
  $s$ INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity) SELECT distributor_id, name, '00:00', '00:01', 1 FROM time_slot WHERE "isActive" LIMIT 1 $s$,
  'UQ_time_slot_nombre_activa');
SELECT pg_temp.falla_con('time_slot · horario que pisa a otra franja activa',
  $s$ INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity) SELECT distributor_id, name || ' bis', "startTime", "endTime", 1 FROM time_slot WHERE "isActive" LIMIT 1 $s$,
  'EXC_time_slot_solapada');
SELECT pg_temp.funciona('time_slot · franja que empieza justo donde termina otra',
  $s$ INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity) SELECT distributor_id, name || ' pegada', "endTime", '23:59', 1 FROM time_slot WHERE "isActive" AND "endTime" < '23:00' ORDER BY "endTime" DESC LIMIT 1 $s$);
SELECT pg_temp.funciona('time_slot · una franja inactiva no choca con las activas',
  $s$ INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity, "isActive") SELECT distributor_id, name, "startTime", "endTime", 1, false FROM time_slot WHERE "isActive" LIMIT 1 $s$);

-- Zonas: nombre y prioridad únicos entre las activas.
SELECT pg_temp.falla_con('coverage_zone · mismo nombre entre activas',
  $s$ INSERT INTO coverage_zone (distributor_id, name, area, surcharge_value, surcharge_type, priority) SELECT distributor_id, upper(name), area, 0, 'fixed', 9999 FROM coverage_zone WHERE "isActive" AND "deletedAt" IS NULL LIMIT 1 $s$,
  'UQ_coverage_zone_nombre_activa');
SELECT pg_temp.falla_con('coverage_zone · misma prioridad entre activas',
  $s$ INSERT INTO coverage_zone (distributor_id, name, area, surcharge_value, surcharge_type, priority) SELECT distributor_id, name || ' bis', area, 0, 'fixed', priority FROM coverage_zone WHERE "isActive" AND "deletedAt" IS NULL LIMIT 1 $s$,
  'UQ_coverage_zone_prioridad_activa');
SELECT pg_temp.funciona('coverage_zone · una zona inactiva puede repetir nombre y prioridad',
  $s$ INSERT INTO coverage_zone (distributor_id, name, area, surcharge_value, surcharge_type, priority, "isActive") SELECT distributor_id, name, area, 0, 'fixed', priority, false FROM coverage_zone WHERE "isActive" AND "deletedAt" IS NULL LIMIT 1 $s$);

-- Envases y garrafas: sin distinguir mayúsculas ni espacios.
SELECT pg_temp.falla_con('cylinder · serial repetido con otra capitalización y espacios',
  $s$ INSERT INTO cylinder (distributor_id, serial) SELECT distributor_id, ' ' || lower(serial) || ' ' FROM cylinder LIMIT 1 $s$,
  'UQ_cylinder_serial_normalizado');
SELECT pg_temp.falla_con('gas_cylinder · tipo repetido con otra capitalización y espacios',
  $s$ INSERT INTO gas_cylinder (distributor_id, type, weight, price) SELECT distributor_id, ' ' || upper(type), 1, 1 FROM gas_cylinder LIMIT 1 $s$,
  'UQ_gas_cylinder_tipo_normalizado');

-- Jornadas, asignaciones de vehículo y reglas de comisión que se pisan.
SELECT pg_temp.falla_con('employee_attendance · dos jornadas del mismo empleado que se pisan',
  $s$ INSERT INTO employee_attendance (distributor_id, employee_id, work_date, check_in_at, check_out_at, source)
        SELECT distributor_id, employee_id, '2100-01-01', '2100-01-01 08:00+00', '2100-01-01 17:00+00', 'panel' FROM employee LIMIT 1;
      INSERT INTO employee_attendance (distributor_id, employee_id, work_date, check_in_at, check_out_at, source)
        SELECT distributor_id, employee_id, '2100-01-01', '2100-01-01 12:00+00', NULL, 'panel' FROM employee_attendance WHERE work_date = '2100-01-01' LIMIT 1 $s$,
  'EXC_employee_attendance_solapada');
SELECT pg_temp.funciona('employee_attendance · jornadas seguidas sin pisarse',
  $s$ INSERT INTO employee_attendance (distributor_id, employee_id, work_date, check_in_at, check_out_at, source)
        SELECT distributor_id, employee_id, '2100-02-01', '2100-02-01 08:00+00', '2100-02-01 12:00+00', 'panel' FROM employee LIMIT 1;
      INSERT INTO employee_attendance (distributor_id, employee_id, work_date, check_in_at, check_out_at, source)
        SELECT distributor_id, employee_id, '2100-02-01', '2100-02-01 12:00+00', '2100-02-01 17:00+00', 'panel' FROM employee_attendance WHERE work_date = '2100-02-01' LIMIT 1 $s$);

SELECT pg_temp.falla_con('vehicle_assignment · el mismo vehículo con dos choferes a la vez',
  $s$ UPDATE vehicle_assignment SET released_at = assigned_at + interval '1 minute' WHERE released_at IS NULL;
      INSERT INTO vehicle_assignment (distributor_id, car_id, delivery_id, assigned_at, released_at)
        SELECT c.distributor_id, c.car_id, (SELECT delivery_id FROM delivery ORDER BY delivery_id LIMIT 1), '2100-01-01', '2100-01-03' FROM car c ORDER BY c.car_id LIMIT 1;
      INSERT INTO vehicle_assignment (distributor_id, car_id, delivery_id, assigned_at, released_at)
        SELECT c.distributor_id, c.car_id, (SELECT delivery_id FROM delivery ORDER BY delivery_id DESC LIMIT 1), '2100-01-02', '2100-01-04' FROM car c ORDER BY c.car_id LIMIT 1 $s$,
  'EXC_vehicle_assignment_vehiculo_solapada');
SELECT pg_temp.falla_con('vehicle_assignment · el mismo chofer con dos vehículos a la vez',
  $s$ UPDATE vehicle_assignment SET released_at = assigned_at + interval '1 minute' WHERE released_at IS NULL;
      INSERT INTO vehicle_assignment (distributor_id, car_id, delivery_id, assigned_at, released_at)
        SELECT c.distributor_id, c.car_id, (SELECT delivery_id FROM delivery ORDER BY delivery_id LIMIT 1), '2200-01-01', '2200-01-03' FROM car c ORDER BY c.car_id LIMIT 1;
      INSERT INTO vehicle_assignment (distributor_id, car_id, delivery_id, assigned_at, released_at)
        SELECT c.distributor_id, c.car_id, (SELECT delivery_id FROM delivery ORDER BY delivery_id LIMIT 1), '2200-01-02', '2200-01-04' FROM car c ORDER BY c.car_id DESC LIMIT 1 $s$,
  'EXC_vehicle_assignment_chofer_solapada');
SELECT pg_temp.funciona('vehicle_assignment · se libera y se asigna al instante (el borde no choca)',
  $s$ UPDATE vehicle_assignment SET released_at = assigned_at + interval '1 minute' WHERE released_at IS NULL;
      INSERT INTO vehicle_assignment (distributor_id, car_id, delivery_id, assigned_at, released_at)
        SELECT c.distributor_id, c.car_id, (SELECT delivery_id FROM delivery ORDER BY delivery_id LIMIT 1), '2300-01-01', '2300-01-03' FROM car c ORDER BY c.car_id LIMIT 1;
      INSERT INTO vehicle_assignment (distributor_id, car_id, delivery_id, assigned_at, released_at)
        SELECT c.distributor_id, c.car_id, (SELECT delivery_id FROM delivery ORDER BY delivery_id DESC LIMIT 1), '2300-01-03', NULL FROM car c ORDER BY c.car_id LIMIT 1 $s$);

SELECT pg_temp.falla_con('commission_rule · dos reglas activas del mismo alcance con vigencias que se pisan',
  $s$ INSERT INTO commission_rule (distributor_id, basis, value, valid_from, valid_to) SELECT distributor_id, 'per_unit', 1, '2100-01-01', '2100-12-31' FROM distributor LIMIT 1;
      INSERT INTO commission_rule (distributor_id, basis, value, valid_from, valid_to) SELECT distributor_id, 'per_unit', 2, '2100-06-01', NULL FROM distributor LIMIT 1 $s$,
  'EXC_commission_rule_solapada');
SELECT pg_temp.funciona('commission_rule · reglas consecutivas, o una inactiva, no chocan',
  $s$ INSERT INTO commission_rule (distributor_id, basis, value, valid_from, valid_to) SELECT distributor_id, 'per_unit', 1, '2200-01-01', '2200-12-31' FROM distributor LIMIT 1;
      INSERT INTO commission_rule (distributor_id, basis, value, valid_from, valid_to) SELECT distributor_id, 'per_unit', 2, '2201-01-01', NULL FROM distributor LIMIT 1;
      INSERT INTO commission_rule (distributor_id, basis, value, valid_from, valid_to, is_active) SELECT distributor_id, 'per_unit', 3, '2200-06-01', NULL, false FROM distributor LIMIT 1 $s$);

-- ---------------------------------------------------------------------------
-- 3. Claves foráneas
-- ---------------------------------------------------------------------------
SELECT pg_temp.falla_con('order · payment_confirmed_by apunta a un usuario que no existe',
  $s$ UPDATE "order" SET payment_confirmed_by = gen_random_uuid() WHERE order_id = (SELECT order_id FROM "order" LIMIT 1) $s$,
  'FK_order_payment_confirmed_by');
SELECT pg_temp.falla_con('order · payment_resolved_by apunta a un usuario que no existe',
  $s$ UPDATE "order" SET payment_resolved_by = gen_random_uuid() WHERE order_id = (SELECT order_id FROM "order" LIMIT 1) $s$,
  'FK_order_payment_resolved_by');
SELECT pg_temp.falla_con('order · vehicle_car_id apunta a un vehículo que no existe',
  $s$ UPDATE "order" SET vehicle_car_id = gen_random_uuid() WHERE order_id = (SELECT order_id FROM "order" LIMIT 1) $s$,
  'FK_order_vehicle_car');
SELECT pg_temp.falla_con('fuel_load · cash_movement_id apunta a un asiento que no existe',
  $s$ UPDATE fuel_load SET cash_movement_id = gen_random_uuid() WHERE fuel_load_id = (SELECT fuel_load_id FROM fuel_load LIMIT 1) $s$,
  'FK_fuel_load_cash_movement');
SELECT pg_temp.falla_con('purchase_receipt · cash_movement_id apunta a un asiento que no existe',
  $s$ UPDATE purchase_receipt SET cash_movement_id = gen_random_uuid() WHERE receipt_id = (SELECT receipt_id FROM purchase_receipt LIMIT 1) $s$,
  'FK_purchase_receipt_cash_movement');
SELECT pg_temp.falla_con('purchase_receipt · voided_by_user_id apunta a un usuario que no existe',
  $s$ UPDATE purchase_receipt SET voided_by_user_id = gen_random_uuid() WHERE receipt_id = (SELECT receipt_id FROM purchase_receipt LIMIT 1) $s$,
  'FK_purchase_receipt_voided_by');

-- Las claves de payment_refund y traffic_fine (tablas vacías) se comprueban en el catálogo.
SELECT pg_temp.afirma('catálogo · FK_payment_refund_requested_by existe y es RESTRICT',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_payment_refund_requested_by' AND contype = 'f' AND confdeltype = 'r'));
SELECT pg_temp.afirma('catálogo · FK_traffic_fine_cash_movement existe y es RESTRICT',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_traffic_fine_cash_movement' AND contype = 'f' AND confdeltype = 'r'));
SELECT pg_temp.afirma('catálogo · FK_order_vehicle_car es SET NULL (el pedido conserva la foto del vehículo)',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_order_vehicle_car' AND contype = 'f' AND confdeltype = 'n'));

-- ---------------------------------------------------------------------------
-- 4. El sistema da de baja, no borra: usuarios y pedidos no se llevan puesta su historia
-- ---------------------------------------------------------------------------
SELECT pg_temp.falla_con('user · un DELETE físico de un cliente con perfil es rechazado',
  $s$ DELETE FROM "user" WHERE user_id = (SELECT user_id FROM customer LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.falla_con('user · un DELETE físico de un chofer con perfil es rechazado',
  $s$ DELETE FROM "user" WHERE user_id = (SELECT user_id FROM delivery LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.falla_con('user · un DELETE físico de quien tiene direcciones es rechazado',
  $s$ DELETE FROM "user" WHERE user_id = (SELECT user_id FROM user_address LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.falla_con('user · un DELETE físico de quien tiene un vehículo es rechazado',
  $s$ DELETE FROM "user" WHERE user_id = (SELECT user_id FROM car LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.falla_con('order · un DELETE físico de un pedido calificado es rechazado',
  $s$ DELETE FROM "order" WHERE order_id = (SELECT order_id FROM rating LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.falla_con('order · un DELETE físico de un pedido con incidentes es rechazado',
  $s$ DELETE FROM "order" WHERE order_id = (SELECT order_id FROM incident LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.falla_con('order · un DELETE físico de un pedido con historial de estados es rechazado',
  $s$ DELETE FROM "order" WHERE order_id = (SELECT order_id FROM order_status_history LIMIT 1) $s$,
  'SQLSTATE:23503');
SELECT pg_temp.afirma('catálogo · las 9 claves de usuario y pedido son RESTRICT',
  (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confdeltype = 'r' AND conname IN (
     'FK_5d1f609371a285123294fddcf3a','FK_a3b8af1ce2f6e143d416d83080a','FK_c8d34198d86de9e96aae03b8990',
     'FK_29d6df815a78e4c8291d3cf5e53','FK_a28028ba709cd7e5053a86857b4','FK_beb6f44b22a7f1ed7cad984a2e1',
     'FK_8a89ba6c226022354d0d8b4ada0','FK_1ca7d5228cf9dc589b60243933c','FK_4c82c1fe16612f55a925ec87741')) = 9);

-- ---------------------------------------------------------------------------
-- 4b. El estado de un pago no retrocede (trigger)
-- ---------------------------------------------------------------------------
SELECT pg_temp.falla_con('payment · un pago aprobado no vuelve a pendiente',
  $s$ UPDATE payment SET status = 'pending' WHERE payment_id = (SELECT payment_id FROM payment WHERE status = 'approved' LIMIT 1) $s$,
  'CHK_payment_estado_no_retrocede');
SELECT pg_temp.falla_con('payment · un pago aprobado no pasa a rechazado',
  $s$ UPDATE payment SET status = 'rejected' WHERE payment_id = (SELECT payment_id FROM payment WHERE status = 'approved' LIMIT 1) $s$,
  'CHK_payment_estado_no_retrocede');
SELECT pg_temp.funciona('payment · un pago aprobado puede pasar a devuelto',
  $s$ UPDATE payment SET status = 'refunded' WHERE payment_id = (SELECT payment_id FROM payment WHERE status = 'approved' LIMIT 1) $s$);
SELECT pg_temp.funciona('payment · un pago pendiente puede pasar a aprobado',
  $s$ INSERT INTO payment (order_id, gateway, integration, amount, status) SELECT order_id, gateway, integration, 1, 'pending' FROM payment LIMIT 1;
      UPDATE payment SET status = 'approved' WHERE payment_id = (SELECT payment_id FROM payment WHERE amount = 1 AND status = 'pending' LIMIT 1) $s$);

-- ---------------------------------------------------------------------------
-- 5. Esquema
-- ---------------------------------------------------------------------------
SELECT pg_temp.afirma('delivery.balance es numeric(12,2)',
  (SELECT data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 2
     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'delivery' AND column_name = 'balance'));
SELECT pg_temp.afirma('order.payment_surcharge_amount es numeric(10,2) NOT NULL DEFAULT 0',
  (SELECT data_type = 'numeric' AND numeric_precision = 10 AND numeric_scale = 2 AND is_nullable = 'NO' AND column_default LIKE '%0%'
     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order' AND column_name = 'payment_surcharge_amount'));
SELECT pg_temp.afirma('btree_gist está instalada', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'));
SELECT pg_temp.afirma('ninguna restricción de la tanda quedó sin validar',
  NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated));
SELECT pg_temp.afirma('es_cuit_valido y es_cuil_valido: dígito verificador y prefijo',
  es_cuit_valido('30712345671') AND NOT es_cuit_valido('30712345670') AND NOT es_cuit_valido('12345678901')
  AND es_cuil_valido('20413255903') AND NOT es_cuil_valido('30712345671') AND NOT es_cuit_valido(NULL));
SELECT pg_temp.afirma('los pedidos que ya había cumplen la fórmula del total',
  NOT EXISTS (SELECT 1 FROM "order" WHERE "totalAmount" <> subtotal_items + zone_surcharge_amount + payment_surcharge_amount
                + CASE WHEN express_degraded_at IS NULL THEN express_surcharge_amount ELSE 0 END));

-- ---------------------------------------------------------------------------
-- Resultado
-- ---------------------------------------------------------------------------
SELECT format('%s casos: %s bien, %s mal', count(*), count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok)) AS resumen FROM resultado;
SELECT caso, detalle FROM resultado WHERE NOT ok ORDER BY orden;

DO $f$
DECLARE v_mal int;
BEGIN
  SELECT count(*) INTO v_mal FROM resultado WHERE NOT ok;
  IF v_mal > 0 THEN
    RAISE EXCEPTION 'verificar-constraints: % caso(s) con problemas (ver arriba)', v_mal;
  END IF;
END $f$;

ROLLBACK;
