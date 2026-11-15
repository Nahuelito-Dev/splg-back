import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDelPedidoPorChofer,
  sentenciasParaQuitarElPedidoPorChofer,
} from './sql/conversacion-del-chofer-por-pedido';

/**
 * Corrección 1 de CH3:
 *  - La conversación C2 por pedido es del pedido **y del chofer**: si el
 *    pedido pasa a otro chofer, el nuevo abre la suya y la del anterior se
 *    cierra (`closed_reason = 'driver_changed'`). El único parcial
 *    `UQ_conversation_pedido_abierta` suma el chofer (en C3, nulo).
 *  - La cita guarda la vista previa del mensaje citado al momento de citarlo
 *    (`reply_to_preview`): no cambia si después se redacta.
 *
 * Columna y CHECK de `message` generados con `migration:generate`; el índice
 * parcial y el CHECK del motivo de cierre (que TypeORM no detecta), a mano.
 */
export class ConversacionDelChoferPorPedido1795000000104
  implements MigrationInterface
{
  name = 'ConversacionDelChoferPorPedido1795000000104';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message" ADD "reply_to_preview" character varying(140)`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_respuesta_vista" CHECK ("reply_to_preview" IS NULL OR "reply_to_seq" IS NOT NULL)`,
    );
    for (const sentencia of sentenciasDelPedidoPorChofer()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_motivo_de_cierre"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_motivo_de_cierre" CHECK ("closed_reason" IS NULL OR "closed_reason" IN ('manual', 'inactivity', 'ticket_closed', 'driver_changed'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_motivo_de_cierre"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_motivo_de_cierre" CHECK ("closed_reason" IS NULL OR "closed_reason" IN ('manual', 'inactivity', 'ticket_closed'))`,
    );
    for (const sentencia of sentenciasParaQuitarElPedidoPorChofer()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_respuesta_vista"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP COLUMN "reply_to_preview"`,
    );
  }
}
