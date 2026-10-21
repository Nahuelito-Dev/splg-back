import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CREAR_FUNCION_ESTADO_DEL_PAGO,
  CREAR_TRIGGER_ESTADO_DEL_PAGO,
} from './sql/estado-del-pago';

/**
 * Dos ajustes de la ronda 2 de la tanda de validaciones:
 *  - un movimiento de envase sin cambio de estado es legítimo cuando es una
 *    anotación del historial (la revisión rechazada de un envase que está
 *    afuera): se permite si trae nota. Sin nota, sigue siendo un error;
 *  - el estado de un pago no retrocede (trigger): un pago aprobado sólo puede
 *    pasar a devuelto; los rechazados, cancelados y devueltos no cambian.
 */
export class EstadoDelPagoYMovimientoDeEnvase1792701000000
  implements MigrationInterface
{
  name = 'EstadoDelPagoYMovimientoDeEnvase1792701000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" DROP CONSTRAINT "CHK_cylinder_movement_cambio"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" ADD CONSTRAINT "CHK_cylinder_movement_cambio" CHECK ("from_state" IS NULL OR "from_state"::text <> "to_state"::text OR "note" IS NOT NULL) NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" VALIDATE CONSTRAINT "CHK_cylinder_movement_cambio"`,
    );

    await queryRunner.query(CREAR_FUNCION_ESTADO_DEL_PAGO);
    await queryRunner.query(CREAR_TRIGGER_ESTADO_DEL_PAGO);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El CHECK estricto no admite un movimiento sin cambio de estado: si ya hay
    // anotaciones legítimas (revisión rechazada de un envase que está afuera) no
    // se puede volver atrás sin perder esa historia. Se aborta antes de tocar
    // nada, con el diagnóstico; si se decide descartarlas, se borran a mano.
    const anotaciones = (await queryRunner.query(
      `SELECT count(*)::int AS total FROM "cylinder_movement"
        WHERE "from_state"::text = "to_state"::text`,
    )) as Array<{ total: number }>;
    if (anotaciones[0].total > 0) {
      throw new Error(
        `No se puede deshacer EstadoDelPagoYMovimientoDeEnvase: hay ${anotaciones[0].total} movimiento(s) de envase sin cambio de estado (anotaciones de revisiones rechazadas). Revisalos (SELECT * FROM cylinder_movement WHERE from_state::text = to_state::text) y, si corresponde descartarlos, borralos antes de reintentar.`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER "TRG_payment_estado_no_retrocede" ON "payment"`,
    );
    await queryRunner.query(`DROP FUNCTION payment_estado_no_retrocede()`);
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" DROP CONSTRAINT "CHK_cylinder_movement_cambio"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" ADD CONSTRAINT "CHK_cylinder_movement_cambio" CHECK ("from_state" IS NULL OR "from_state"::text <> "to_state"::text)`,
    );
  }
}
