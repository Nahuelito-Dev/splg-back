import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Métricas del chat y del asistente (B4):
 *
 * 1. `IDX_conversation_metricas`: las conversaciones de una empresa y un canal
 *    creadas en un período (`GET /v2/chat/metrics`).
 * 2. `IDX_message_fecha`: los mensajes de un período de todas las empresas
 *    (`GET /v2/platform/chat/metrics` sin `distributorId`; el de siempre
 *    arranca por la empresa).
 *
 * Sin tabla de hechos: las métricas se calculan sobre `conversation`,
 * `message`, `support_ticket`, `conversation_rating` y `assistant_trace`.
 */
export class IndiceDeLasMetricasDelChat1795000000135
  implements MigrationInterface
{
  name = 'IndiceDeLasMetricasDelChat1795000000135';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_metricas" ON "conversation" ("distributor_id", "channel", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_fecha" ON "message" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_message_fecha"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_conversation_metricas"`);
  }
}
