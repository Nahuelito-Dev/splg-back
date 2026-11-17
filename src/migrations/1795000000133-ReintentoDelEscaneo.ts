import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDelReintentoDelEscaneo,
  sentenciasParaQuitarElReintentoDelEscaneo,
} from './sql/reintento-del-escaneo';

/**
 * Reintento del escaneo de los adjuntos del chat (corrección 1 de CH7):
 *
 * 1. `attachment.scan_attempts` (intentos hechos; 0 en los de siempre), con
 *    `CHK_attachment_escaneo_intentos` (0–50, y sólo los del chat).
 * 2. `IDX_attachment_escaneo_pendiente` cubre también los `failed` (la tarea
 *    programada los reintenta).
 * 3. `TRG_attachment_escaneo` (`sql/reintento-del-escaneo.ts`): `failed` se
 *    reintenta o se resuelve; `clean` e `infected` son finales; los intentos
 *    no bajan.
 */
export class ReintentoDelEscaneo1795000000133 implements MigrationInterface {
  name = 'ReintentoDelEscaneo1795000000133';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD "scan_attempts" smallint NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_escaneo_intentos" CHECK ("scan_attempts" BETWEEN 0 AND 50 AND ("message_id" IS NOT NULL OR "scan_attempts" = 0))`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_attachment_escaneo_pendiente"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_escaneo_pendiente" ON "attachment" ("uploaded_at") WHERE "scan_status" IN ('pending', 'failed')`,
    );
    for (const sentencia of sentenciasDelReintentoDelEscaneo()) {
      await queryRunner.query(sentencia);
    }
  }

  /** Vuelve al trigger de `AdjuntosDelChat` (`failed` final) y saca los intentos. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sentencia of sentenciasParaQuitarElReintentoDelEscaneo()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `DROP INDEX "public"."IDX_attachment_escaneo_pendiente"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_escaneo_pendiente" ON "attachment" ("uploaded_at") WHERE "scan_status" = 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP CONSTRAINT "CHK_attachment_escaneo_intentos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP COLUMN "scan_attempts"`,
    );
  }
}
