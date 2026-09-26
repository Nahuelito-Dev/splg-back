import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * La validación de clientes se elimina (decisión del 26/09): el cliente se
 * registra y compra, no hay nada que aprobar, y la marca no condicionaba ningún
 * pedido. Los choferes siguen validándose (`delivery.validated`).
 *
 * El `down` vuelve a crear la columna con todos en false: qué clientes estaban
 * validados no se puede recuperar.
 */
export class ClienteSinValidacion1790457267161 implements MigrationInterface {
  name = 'ClienteSinValidacion1790457267161';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customer" DROP COLUMN "validated"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer" ADD "validated" boolean NOT NULL DEFAULT false`,
    );
  }
}
