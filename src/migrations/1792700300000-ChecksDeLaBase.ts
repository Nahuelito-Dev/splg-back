import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CREAR_ES_CUIL_VALIDO,
  CREAR_ES_CUIT_VALIDO,
} from './sql/funciones-cuit';

/**
 * CHECK de la base para las reglas de negocio que hasta ahora vivían sólo en el
 * back: montos, estados con sus fechas y motivos, formatos y rangos. Cada una
 * se agrega `NOT VALID` y se valida enseguida, así el cambio de esquema es
 * rápido y, si hubiera una fila que la rompe, la migración falla entera.
 *
 * Las funciones `es_cuit_valido` / `es_cuil_valido` repiten en SQL el dígito
 * verificador que el back valida con `esCuitValido` / `esCuilValido`.
 */
export class ChecksDeLaBase1792700300000 implements MigrationInterface {
  name = 'ChecksDeLaBase1792700300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CREAR_ES_CUIT_VALIDO);
    await queryRunner.query(CREAR_ES_CUIL_VALIDO);

    // La promoción máxima baja de 100 % a 99 %: a 100 % el producto quedaría gratis.
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" DROP CONSTRAINT "CHK_promocion_descuento"`,
    );
    await this.agregar(
      queryRunner,
      'gas_cylinder_promotion',
      'CHK_promocion_descuento',
      '"discount_percentage" > 0 AND "discount_percentage" <= 99',
    );

    for (const [tabla, nombre, expresion] of CHECKS) {
      await this.agregar(queryRunner, tabla, nombre, expresion);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, nombre] of [...CHECKS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${nombre}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" DROP CONSTRAINT "CHK_promocion_descuento"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" ADD CONSTRAINT "CHK_promocion_descuento" CHECK ("discount_percentage" > 0 AND "discount_percentage" <= 100)`,
    );
    await queryRunner.query(`DROP FUNCTION es_cuil_valido(text)`);
    await queryRunner.query(`DROP FUNCTION es_cuit_valido(text)`);
  }

  private async agregar(
    queryRunner: QueryRunner,
    tabla: string,
    nombre: string,
    expresion: string,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombre}" CHECK (${expresion}) NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "${tabla}" VALIDATE CONSTRAINT "${nombre}"`,
    );
  }
}

/** [tabla, nombre, expresión] */
const CHECKS: ReadonlyArray<readonly [string, string, string]> = [
  [
    'order',
    'CHK_order_montos',
    `"totalAmount" >= 0 AND "subtotal_items" >= 0 AND "zone_surcharge_amount" >= 0 AND "express_surcharge_amount" >= 0 AND "payment_surcharge_amount" >= 0 AND "deposit_amount" >= 0`,
  ],
  [
    'order',
    'CHK_order_pago_coherente',
    `("paymentMethod" = 'cash') = ("paymentType" = 'cash') AND ("paymentMethod" = 'account') = ("paymentType" = 'account')`,
  ],
  [
    'order',
    'CHK_order_aceptado_fecha',
    `"status" NOT IN ('accepted', 'on_the_way', 'delivered') OR "acceptedAt" IS NOT NULL`,
  ],
  [
    'order',
    'CHK_order_en_camino_fecha',
    `"status" NOT IN ('on_the_way', 'delivered') OR "onTheWayAt" IS NOT NULL`,
  ],
  [
    'order',
    'CHK_order_entregado_fecha',
    `("status" = 'delivered') = ("deliveredAt" IS NOT NULL)`,
  ],
  [
    'order',
    'CHK_order_chofer_asignado',
    `"status" NOT IN ('accepted', 'on_the_way', 'delivered') OR "delivery_id" IS NOT NULL`,
  ],
  [
    'order',
    'CHK_order_cancelado_motivo',
    `"status" <> 'cancelled' OR btrim(coalesce("cancellationReason", '')) <> ''`,
  ],
  ['order_item', 'CHK_order_item_cantidad', `"quantity" > 0`],
  [
    'order_item',
    'CHK_order_item_importes',
    `"unitPrice" >= 0 AND "subtotal" >= 0`,
  ],
  ['cart_item', 'CHK_cart_item_cantidad', `"quantity" BETWEEN 1 AND 999`],
  ['cart_item', 'CHK_cart_item_precio', `"unit_price" >= 0`],
  ['payment', 'CHK_payment_importe', `"amount" > 0`],
  ['payment_refund', 'CHK_payment_refund_importe', `"amount" > 0`],
  ['payment_refund', 'CHK_payment_refund_intentos', `"attempts" >= 0`],
  [
    'payment_refund',
    'CHK_payment_refund_exito_fecha',
    `"status" <> 'succeeded' OR "refunded_at" IS NOT NULL`,
  ],
  [
    'cash_session',
    'CHK_cash_session_montos',
    `"opening_amount" >= 0 AND ("counted_amount" IS NULL OR "counted_amount" >= 0)`,
  ],
  [
    'cash_session',
    'CHK_cash_session_cierre_fecha',
    `("status" = 'closed') = ("closed_at" IS NOT NULL)`,
  ],
  [
    'cash_session',
    'CHK_cash_session_cierre_completo',
    `"status" <> 'closed' OR ("closed_by_user_id" IS NOT NULL AND "counted_amount" IS NOT NULL AND "expected_amount" IS NOT NULL AND "difference" = "counted_amount" - "expected_amount")`,
  ],
  [
    'cash_session',
    'CHK_cash_session_periodo',
    `"closed_at" IS NULL OR "closed_at" >= "opened_at"`,
  ],
  [
    'customer_account',
    'CHK_customer_account_plazo_maximo',
    `"payment_terms_days" <= 365`,
  ],
  [
    'customer_account',
    'CHK_customer_account_cerrada_sin_saldo',
    `"status" <> 'closed' OR "balance" = 0`,
  ],
  [
    'customer_account',
    'CHK_customer_account_cuit',
    `"tax_id" IS NULL OR es_cuit_valido("tax_id")`,
  ],
  [
    'customer_account_entry',
    'CHK_customer_account_entry_vencimiento',
    `"due_date" IS NULL OR "due_date" >= ("occurred_at" AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`,
  ],
  [
    'driver_settlement',
    'CHK_driver_settlement_montos',
    `"expected_cash" >= 0 AND "driver_expenses" >= 0 AND ("declared_cash" IS NULL OR "declared_cash" >= 0)`,
  ],
  [
    'driver_settlement',
    'CHK_driver_settlement_presentada',
    `"status" = 'open' OR ("submitted_at" IS NOT NULL AND "declared_cash" IS NOT NULL)`,
  ],
  [
    'driver_settlement',
    'CHK_driver_settlement_aprobada',
    `("status" = 'approved') = ("approved_at" IS NOT NULL)`,
  ],
  [
    'driver_settlement',
    'CHK_driver_settlement_diferencia',
    `"difference" IS NULL OR "difference" = "declared_cash" + "driver_expenses" - "expected_cash"`,
  ],
  [
    'driver_settlement_order',
    'CHK_driver_settlement_order_importe',
    `"amount" >= 0`,
  ],
  [
    'driver_settlement_collection',
    'CHK_driver_settlement_collection_importe',
    `"amount" > 0`,
  ],
  [
    'driver_liquidation',
    'CHK_driver_liquidation_periodo',
    `"period_from" <= "period_to"`,
  ],
  [
    'driver_liquidation',
    'CHK_driver_liquidation_montos',
    `"gross" >= 0 AND "deductions" >= 0 AND "net" = "gross" - "deductions"`,
  ],
  [
    'driver_liquidation',
    'CHK_driver_liquidation_aprobada',
    `"status" NOT IN ('approved', 'paid') OR "approved_at" IS NOT NULL`,
  ],
  [
    'driver_liquidation',
    'CHK_driver_liquidation_pagada',
    `("status" = 'paid') = ("paid_at" IS NOT NULL)`,
  ],
  [
    'driver_liquidation',
    'CHK_driver_liquidation_anulada',
    `("status" = 'voided') = ("voided_at" IS NOT NULL)`,
  ],
  [
    'commission_rule',
    'CHK_commission_rule_porcentaje',
    `"basis" <> 'percent_of_total' OR "value" <= 100`,
  ],
  ['commission_entry', 'CHK_commission_entry_importe', `"amount" <> 0`],
  [
    'commission_entry',
    'CHK_commission_entry_signo',
    `("type" <> 'delivery_commission' OR "amount" > 0) AND ("type" <> 'settlement_shortage' OR "amount" < 0)`,
  ],
  [
    'gas_cylinder',
    'CHK_gas_cylinder_valores',
    `"price" > 0 AND "weight" > 0 AND "stock" >= 0 AND "reservation_deficit" >= 0 AND ("average_unit_cost" IS NULL OR "average_unit_cost" >= 0)`,
  ],
  ['gas_cylinder', 'CHK_gas_cylinder_tipo', `btrim("type") <> ''`],
  ['cylinder', 'CHK_cylinder_garantia', `"deposit" >= 0`],
  [
    'cylinder',
    'CHK_cylinder_cliente_segun_estado',
    `("state" = 'with_customer') = ("current_customer_id" IS NOT NULL)`,
  ],
  [
    'cylinder',
    'CHK_cylinder_vencimiento',
    `"expires_at" IS NULL OR "manufactured_at" IS NULL OR "expires_at" >= "manufactured_at"`,
  ],
  ['cylinder', 'CHK_cylinder_serial', `btrim("serial") <> ''`],
  [
    'cylinder_movement',
    'CHK_cylinder_movement_cambio',
    `"from_state" IS NULL OR "from_state"::text <> "to_state"::text`,
  ],
  [
    'cylinder_inspection',
    'CHK_cylinder_inspection_vencimiento',
    `"next_due_at" IS NULL OR "next_due_at" > "inspected_at"`,
  ],
  [
    'cylinder_inspection',
    'CHK_cylinder_inspection_proxima',
    `"result" = 'rejected' OR "next_due_at" IS NOT NULL`,
  ],
  [
    'stock_movement',
    'CHK_stock_movement_origen_destino_distintos',
    `NOT ("from_location_id" = "to_location_id" AND "from_condition" = "to_condition")`,
  ],
  ['stock_adjustment', 'CHK_stock_adjustment_notas', `btrim("notes") <> ''`],
  [
    'purchase_order',
    'CHK_purchase_order_cancelada',
    `"status" <> 'cancelled' OR "cancel_reason" IS NOT NULL`,
  ],
  [
    'purchase_order',
    'CHK_purchase_order_cerrada_corta',
    `"status" <> 'closed_short' OR "close_reason" IS NOT NULL`,
  ],
  [
    'purchase_order',
    'CHK_purchase_order_emitida',
    `"status" IN ('draft', 'cancelled') OR "issued_at" IS NOT NULL`,
  ],
  ['purchase_order', 'CHK_purchase_order_total', `"total_amount" >= 0`],
  ['purchase_receipt', 'CHK_purchase_receipt_total', `"total_amount" >= 0`],
  [
    'purchase_receipt',
    'CHK_purchase_receipt_anulada_fecha',
    `("status" = 'voided') = ("voided_at" IS NOT NULL)`,
  ],
  [
    'purchase_receipt',
    'CHK_purchase_receipt_anulacion_datos',
    `"status" <> 'voided' OR ("void_reason" IS NOT NULL AND "voided_by_user_id" IS NOT NULL)`,
  ],
  ['supplier', 'CHK_supplier_cuit', `es_cuit_valido("cuit")`],
  [
    'truck_load',
    'CHK_truck_load_salida',
    `"status" IN ('loading', 'cancelled') OR "departed_at" IS NOT NULL`,
  ],
  [
    'truck_load',
    'CHK_truck_load_regreso',
    `"status" NOT IN ('returned', 'closed', 'closed_with_difference') OR "returned_at" IS NOT NULL`,
  ],
  [
    'truck_load',
    'CHK_truck_load_cierre',
    `"status" NOT IN ('closed', 'closed_with_difference', 'cancelled') OR "closed_at" IS NOT NULL`,
  ],
  [
    'truck_load',
    'CHK_truck_load_cancelada',
    `"status" <> 'cancelled' OR "cancel_reason" IS NOT NULL`,
  ],
  [
    'traffic_fine',
    'CHK_traffic_fine_pago_voluntario',
    `"voluntary_payment_amount" IS NULL OR ("voluntary_payment_amount" > 0 AND "voluntary_payment_amount" <= "amount")`,
  ],
  [
    'traffic_fine',
    'CHK_traffic_fine_importe_pagado',
    `"paid_amount" IS NULL OR "paid_amount" > 0`,
  ],
  [
    'traffic_fine',
    'CHK_traffic_fine_pagada_datos',
    `"status" <> 'paid' OR ("paid_at" IS NOT NULL AND "paid_amount" IS NOT NULL)`,
  ],
  [
    'traffic_fine',
    'CHK_traffic_fine_anulada_fecha',
    `"status" <> 'voided' OR "voided_at" IS NOT NULL`,
  ],
  ['fuel_load', 'CHK_fuel_load_precio', `"unit_price" > 0`],
  ['fuel_load', 'CHK_fuel_load_odometro', `"odometer_km" >= 0`],
  [
    'vehicle_accident',
    'CHK_vehicle_accident_montos',
    `coalesce("repair_cost", 0) >= 0 AND coalesce("insurer_reimbursement", 0) >= 0 AND coalesce("deductible_amount", 0) >= 0 AND ("insurer_reimbursement" IS NULL OR "repair_cost" IS NULL OR "insurer_reimbursement" <= "repair_cost")`,
  ],
  [
    'vehicle_accident',
    'CHK_vehicle_accident_cerrado_fecha',
    `"status" <> 'closed' OR "closed_at" IS NOT NULL`,
  ],
  [
    'maintenance_task',
    'CHK_maintenance_task_valores',
    `coalesce("cost", 0) >= 0 AND coalesce("due_km", 0) >= 0 AND coalesce("odometer_km", 0) >= 0`,
  ],
  [
    'maintenance_task',
    'CHK_maintenance_task_un_sujeto',
    `num_nonnulls("car_id", "delivery_id", "employee_id") = 1`,
  ],
  [
    'maintenance_task',
    'CHK_maintenance_task_hecha_fecha',
    `"status" <> 'done' OR "performed_at" IS NOT NULL`,
  ],
  [
    'tire',
    'CHK_tire_valores',
    `"cost" >= 0 AND "km_traveled" >= 0 AND "retread_count" >= 0`,
  ],
  [
    'tire',
    'CHK_tire_montaje',
    `("status" = 'mounted') = ("car_id" IS NOT NULL AND "position" IS NOT NULL)`,
  ],
  [
    'vehicle_usage_log',
    'CHK_vehicle_usage_log_valores',
    `"km" >= 0 AND "orders" >= 0 AND "route_hours" >= 0`,
  ],
  [
    'vehicle_assignment',
    'CHK_vehicle_assignment_periodo',
    `"released_at" IS NULL OR "released_at" >= "assigned_at"`,
  ],
  [
    'car',
    'CHK_car_patente',
    `"car_patent" IS NULL OR "car_patent" ~ '^([A-Z]{3}[0-9]{3}|[A-Z]{2}[0-9]{3}[A-Z]{2})$'`,
  ],
  [
    'delivery',
    'CHK_delivery_calificacion',
    `"calification" IS NULL OR "calification" BETWEEN 0 AND 5`,
  ],
  [
    'customer',
    'CHK_customer_consumo',
    `"avg_monthly_consumption_kg" IS NULL OR "avg_monthly_consumption_kg" > 0`,
  ],
  [
    'employee',
    'CHK_employee_nacimiento',
    `"birth_date" IS NULL OR "birth_date" < "hire_date"`,
  ],
  ['employee', 'CHK_employee_cuil', `"cuil" IS NULL OR es_cuil_valido("cuil")`],
  [
    'employee',
    'CHK_employee_email',
    `"personal_email" IS NULL OR "personal_email" ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`,
  ],
  [
    'employee',
    'CHK_employee_cbu',
    `"bank_cbu" IS NULL OR "bank_cbu" ~ '^[0-9]{22}$'`,
  ],
  [
    'user',
    'CHK_user_telefono',
    `"phone_number" IS NULL OR "phone_number" ~ '^[+][1-9][0-9]{7,14}$'`,
  ],
  [
    'user',
    'CHK_user_email',
    `"email" IS NULL OR "email" ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`,
  ],
  [
    'rating',
    'CHK_rating_valores',
    `"stars" BETWEEN 1 AND 5 AND "from_user_id" <> "to_user_id" AND (NOT "hidden" OR "hidden_at" IS NOT NULL)`,
  ],
  ['time_slot', 'CHK_time_slot_horario', `"startTime" < "endTime"`],
  ['time_slot', 'CHK_time_slot_capacidad', `"capacity" > 0`],
  [
    'coverage_zone',
    'CHK_coverage_zone_vigencia',
    `"valid_until" IS NULL OR "valid_from" IS NULL OR "valid_until" > "valid_from"`,
  ],
  ['route_batch_stop', 'CHK_route_batch_stop_secuencia', `"sequence" >= 1`],
  [
    'order_dispatch_offer',
    'CHK_order_dispatch_offer_vencimiento',
    `"expiresAt" > "offeredAt"`,
  ],
  [
    'document_sequence',
    'CHK_document_sequence_valores',
    `"last_number" >= 0 AND "doc_type" ~ '^[a-z][a-z0-9_]{0,39}$'`,
  ],
  [
    'distributor',
    'CHK_distributor_cuit',
    `"tax_id" IS NULL OR "tax_id" ~ '^[0-9]{11}$'`,
  ],
  [
    'distributor',
    'CHK_distributor_slug',
    `"slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
  ],
  ['warehouse', 'CHK_warehouse_codigo', `"code" ~ '^[A-Z0-9_-]{1,12}$'`],
  [
    'claims',
    'CHK_claims_textos',
    `btrim("reason") <> '' AND btrim("description") <> ''`,
  ],
  ['incident', 'CHK_incident_descripcion', `btrim("description") <> ''`],
];
