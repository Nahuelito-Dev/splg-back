import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Columnas `*_id` que apuntaban a una fila sin clave foránea que lo garantice.
 * Los usuarios y los asientos de caja se protegen con RESTRICT (el sistema da
 * de baja, no borra). `order.vehicle_car_id` es la foto del vehículo al momento
 * del pedido, que además guarda patente, marca y modelo: si el vehículo se
 * borra, el pedido conserva esos datos.
 */
const CLAVES: ReadonlyArray<
  readonly [string, string, string, string, string, string]
> = [
  [
    'order',
    'payment_confirmed_by',
    'FK_order_payment_confirmed_by',
    'user',
    'user_id',
    'RESTRICT',
  ],
  [
    'order',
    'payment_resolved_by',
    'FK_order_payment_resolved_by',
    'user',
    'user_id',
    'RESTRICT',
  ],
  [
    'order',
    'vehicle_car_id',
    'FK_order_vehicle_car',
    'car',
    'car_id',
    'SET NULL',
  ],
  [
    'payment_refund',
    'requested_by_user_id',
    'FK_payment_refund_requested_by',
    'user',
    'user_id',
    'RESTRICT',
  ],
  [
    'purchase_receipt',
    'voided_by_user_id',
    'FK_purchase_receipt_voided_by',
    'user',
    'user_id',
    'RESTRICT',
  ],
  [
    'purchase_receipt',
    'cash_movement_id',
    'FK_purchase_receipt_cash_movement',
    'cash_movement',
    'movement_id',
    'RESTRICT',
  ],
  [
    'fuel_load',
    'cash_movement_id',
    'FK_fuel_load_cash_movement',
    'cash_movement',
    'movement_id',
    'RESTRICT',
  ],
  [
    'traffic_fine',
    'cash_movement_id',
    'FK_traffic_fine_cash_movement',
    'cash_movement',
    'movement_id',
    'RESTRICT',
  ],
];

export class ClavesForaneasFaltantes1792700500000
  implements MigrationInterface
{
  name = 'ClavesForaneasFaltantes1792700500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, columna, nombre, destino, pk, alBorrar] of CLAVES) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombre}" FOREIGN KEY ("${columna}") REFERENCES "${destino}" ("${pk}") ON DELETE ${alBorrar} NOT VALID`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" VALIDATE CONSTRAINT "${nombre}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, , nombre] of [...CLAVES].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${nombre}"`,
      );
    }
  }
}
