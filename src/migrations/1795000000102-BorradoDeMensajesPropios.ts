import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeMensajesRetirados,
  sentenciasParaQuitarMensajesRetirados,
} from './sql/mensajes-retirados';

/**
 * Borrar un mensaje propio (D-C23, CH3): el cliente retira su mensaje en C3
 * hasta 15 minutos después de enviarlo. Borrado lógico: `withdrawn_at` y
 * quién (`withdrawn_by_user_id`, el mismo autor: CHECK); el texto queda en la
 * fila para la retención (CH8) y la API no lo devuelve más. El trigger
 * `message_inmutable` admite el retiro una sola vez y sólo así
 * (`sql/mensajes-retirados.ts`).
 *
 * Columnas y restricciones generadas con `migration:generate` (revisadas a
 * mano); la auditoría de las columnas nuevas la instala
 * `AuditoriaDelBorradoDeMensajesPropios`.
 */
export class BorradoDeMensajesPropios1795000000102
  implements MigrationInterface
{
  name = 'BorradoDeMensajesPropios1795000000102';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message" ADD "withdrawn_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD "withdrawn_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_retirado" CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by_user_id" IS NULL) AND ("withdrawn_at" IS NULL OR ("sender_party" = 'customer' AND "kind" = 'text' AND "withdrawn_by_user_id" = "sender_user_id")))`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "FK_message_withdrawn_by" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    for (const sentencia of sentenciasDeMensajesRetirados()) {
      await queryRunner.query(sentencia);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sentencia of sentenciasParaQuitarMensajesRetirados()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "FK_message_withdrawn_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_retirado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP COLUMN "withdrawn_by_user_id"`,
    );
    await queryRunner.query(`ALTER TABLE "message" DROP COLUMN "withdrawn_at"`);
  }
}
