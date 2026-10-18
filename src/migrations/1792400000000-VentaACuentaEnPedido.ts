import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El medio de pago y el tipo de pago "cuenta corriente" (`account`) del pedido.
 * Va en una migración aparte de las tablas de caja: un valor nuevo de un enum no
 * se puede usar en la misma transacción que lo agrega. No hay `down`: Postgres
 * no permite quitar un valor de un enum, y uno que sobra no rompe nada.
 */
export class VentaACuentaEnPedido1792400000000 implements MigrationInterface {
  name = 'VentaACuentaEnPedido1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."order_paymentmethod_enum" ADD VALUE IF NOT EXISTS 'account'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."order_paymenttype_enum" ADD VALUE IF NOT EXISTS 'account'`,
    );
  }

  public async down(): Promise<void> {
    // Un valor de un enum no se puede quitar.
  }
}
