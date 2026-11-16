import { MigrationInterface, QueryRunner } from 'typeorm';

/** Índices parciales para buscar el historial de un pedido por su `orderId`. */
export class IndiceAuditoriaPorPedido1791180000000
  implements MigrationInterface
{
  name = 'IndiceAuditoriaPorPedido1791180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_detail_order_nuevo" ON "audit_detail" ("new_value") WHERE "field" = 'orderId'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_detail_order_anterior" ON "audit_detail" ("old_value") WHERE "field" = 'orderId'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_audit_detail_order_anterior"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_detail_order_nuevo"`);
  }
}
