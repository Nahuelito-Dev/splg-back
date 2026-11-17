import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Métricas del despacho (M1): la oferta guarda cuándo respondió el chofer.
 * Nula mientras no responde, en las vencidas y retiradas, y en lo anterior:
 * no se puede reconstruir. La auditoría de la columna la instala la siguiente
 * (`AuditoriaDeLaRespuestaDeLaOferta`).
 */
export class RespuestaDeLaOferta1795000000153 implements MigrationInterface {
  name = 'RespuestaDeLaOferta1795000000153';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD "respondedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP COLUMN "respondedAt"`,
    );
  }
}
