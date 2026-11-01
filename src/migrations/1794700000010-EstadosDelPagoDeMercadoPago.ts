import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CREAR_FUNCION_HISTORIAL_DEL_PAGO,
  CREAR_FUNCION_ESTADO_DEL_PAGO,
  CREAR_TRIGGER_HISTORIAL_DEL_PAGO,
  REEMPLAZAR_FUNCION_ESTADO_DEL_PAGO,
} from './sql/estado-del-pago';

/**
 * El ledger de pagos pasa a los nueve estados de la API de pagos de Mercado Pago
 * (se suman `in_process`, `authorized`, `charged_back` e `in_mediation`), guarda el
 * motivo (`status_detail`) y un historial de sólo agregar de cada cambio de estado.
 *
 * Sin pérdida de datos: los registros existentes conservan su estado; el historial
 * arranca vacío. Los contracargos que hasta hoy figuraban como `refunded` siguen así
 * (no hay forma de distinguirlos en la base; `metadata.gatewayStatus` lo dice).
 */
export class EstadosDelPagoDeMercadoPago1794700000010
  implements MigrationInterface
{
  name = 'EstadosDelPagoDeMercadoPago1794700000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const estado of [
      'in_process',
      'authorized',
      'charged_back',
      'in_mediation',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."payment_status_enum" ADD VALUE IF NOT EXISTS '${estado}'`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "status_detail" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "status_history" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "CHK_payment_detalle_del_estado" CHECK ("status_detail" IS NULL OR char_length(btrim("status_detail")) > 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "CHK_payment_historial_es_lista" CHECK (jsonb_typeof("status_history") = 'array')`,
    );
    await queryRunner.query(REEMPLAZAR_FUNCION_ESTADO_DEL_PAGO);
    await queryRunner.query(CREAR_FUNCION_HISTORIAL_DEL_PAGO);
    await queryRunner.query(CREAR_TRIGGER_HISTORIAL_DEL_PAGO);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres no quita valores de un enum: los cuatro estados nuevos quedan en el
    // tipo, sin usarse. Si hay pagos en alguno de ellos no se puede volver atrás.
    const usados = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "payment" WHERE "status"::text IN ('in_process', 'authorized', 'charged_back', 'in_mediation')`,
    )) as Array<{ n: number }>;
    if (usados[0].n > 0) {
      throw new Error(
        `Hay ${usados[0].n} pago(s) en in_process, authorized, charged_back o in_mediation: no se puede volver al esquema anterior sin decidir antes qué estado les corresponde`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER "TRG_payment_historial_solo_crece" ON "payment"`,
    );
    await queryRunner.query(`DROP FUNCTION payment_historial_solo_crece()`);
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "CHK_payment_historial_es_lista"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "CHK_payment_detalle_del_estado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "status_history"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "status_detail"`,
    );
    await queryRunner.query(
      CREAR_FUNCION_ESTADO_DEL_PAGO.replace(
        'CREATE FUNCTION',
        'CREATE OR REPLACE FUNCTION',
      ),
    );
  }
}
