import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  crearFuncionDeTransicion,
  MAQUINAS_DE_ESTADO,
} from './sql/transiciones-de-estado';

/**
 * Hoja de ruta, etapas E4 (ejecución) y E5 (hora estimada): lo que la hoja en
 * la calle necesita guardar.
 *  - `route_batch.assigned_at`: cuándo los pedidos quedaron asignados al chofer
 *    de la hoja (al confirmarla, o al empezar el día del reparto).
 *  - `route_batch.close_note`: por qué se cerró a mano una hoja con pendientes
 *    (sólo en una hoja cerrada).
 *  - `route_batch_stop.arrived_at` («Llegué»), `wait_alerted_at` (se avisó que
 *    venció la espera en la puerta), `failed_attempts` (0 a 2), `last_failed_at`
 *    y `last_failure_note` (el intento fallido: la parada vuelve al final de la
 *    cola), y `removed_note` (sólo con motivo de salida).
 *  - motivos de salida `sheet_closed` (pendiente al cerrar la hoja a mano: se
 *    reprograma solo), `rescheduled` (segundo intento fallido: se reprogramó
 *    para el día hábil siguiente) y `needs_reschedule` (espera al admin: se
 *    liberó por fuera de la hoja o no se pudo reprogramar).
 *  - pedido: `on_the_way → accepted` (la parada que no se pudo entregar vuelve
 *    al final de la cola del mismo chofer) en el trigger de transiciones.
 *  - parámetro `arrivalWaitMinutes` (1 a 60) de `route_planning` en su CHECK.
 *  - proceso `route_sheet_watch` en el monitoreo.
 *
 * El mapa de auditoría con las columnas nuevas lo aplica la migración
 * (`AuditoriaDeLaEjecucionDeLaHoja`).
 */
/** Rangos de los parámetros de la hoja de ruta (copia congelada de la entidad). */
const RANGOS_ANTERIORES: ReadonlyArray<[string, number, number]> = [
  ['enabled', 0, 1],
  ['cutoffHour', 0, 23],
  ['cutoffMinute', 0, 59],
  ['autoPropose', 0, 1],
  ['maxStopsPerSheet', 2, 40],
  ['serviceMinutes', 1, 60],
  ['trafficFactor', 1, 3],
  ['etaWindowMinutes', 10, 120],
  ['etaRecalcMinSeconds', 30, 900],
  ['etaRecalcMinMeters', 50, 5000],
  ['etaNotifyShiftMinutes', 5, 120],
  ['lateOrderPolicy', 0, 1],
  ['notStartedAlertMinutes', 0, 240],
];
const RANGOS_NUEVOS: ReadonlyArray<[string, number, number]> = [
  ...RANGOS_ANTERIORES,
  ['arrivalWaitMinutes', 1, 60],
];

const checkDeLaHoja = (rangos: ReadonlyArray<[string, number, number]>) =>
  `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_hoja_de_ruta" CHECK ("module"::text <> 'route_planning' OR (${rangos
    .map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'trafficFactor' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
    )
    .join(' AND ')}))`;

const PEDIDO = MAQUINAS_DE_ESTADO.find((m) => m.tabla === 'order');

/** Máquina del pedido antes de que la hoja de ruta pudiera devolver una parada en camino a la cola. */
const PEDIDO_ANTERIOR = PEDIDO && {
  ...PEDIDO,
  transiciones: {
    ...PEDIDO.transiciones,
    on_the_way: ['delivered', 'cancelled', 'pending'],
  },
};

const reemplazar = (sql: string) =>
  sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');

export class EjecucionDeLaHojaDeRuta1795000000037
  implements MigrationInterface
{
  name = 'EjecucionDeLaHojaDeRuta1795000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "route_batch_stop_removed_reason_enum" ADD VALUE IF NOT EXISTS 'sheet_closed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "route_batch_stop_removed_reason_enum" ADD VALUE IF NOT EXISTS 'rescheduled'`,
    );
    await queryRunner.query(
      `ALTER TYPE "route_batch_stop_removed_reason_enum" ADD VALUE IF NOT EXISTS 'needs_reschedule'`,
    );
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'route_sheet_watch'`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "assigned_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "close_note" character varying(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "removed_note" character varying(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "arrived_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "wait_alerted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "failed_attempts" smallint NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "last_failed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "last_failure_note" character varying(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_hoja_entregada" CHECK ("assigned_at" IS NULL OR ("kind" = 'planned' AND "delivery_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_nota_cierre" CHECK ("close_note" IS NULL OR "status" = 'completed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "CHK_route_batch_stop_intentos" CHECK ("failed_attempts" BETWEEN 0 AND 2 AND ("failed_attempts" = 0) = ("last_failed_at" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "CHK_route_batch_stop_nota" CHECK ("removed_note" IS NULL OR "removed_reason" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_NUEVOS));
    if (PEDIDO) {
      await queryRunner.query(reemplazar(crearFuncionDeTransicion(PEDIDO)));
    }
  }

  /**
   * DESTRUCTIVO: borra las columnas de la ejecución (intentos fallidos, llegadas,
   * esperas avisadas, notas y la asignación de las hojas), y esos datos se
   * pierden. Sólo para desarrollo; en producción no se revierte.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    if (PEDIDO_ANTERIOR) {
      await queryRunner.query(
        reemplazar(crearFuncionDeTransicion(PEDIDO_ANTERIOR)),
      );
    }
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_ANTERIORES));
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "CHK_route_batch_stop_nota"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "CHK_route_batch_stop_intentos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_nota_cierre"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_hoja_entregada"`,
    );
    for (const columna of [
      'last_failure_note',
      'last_failed_at',
      'failed_attempts',
      'wait_alerted_at',
      'arrived_at',
      'removed_note',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "route_batch_stop" DROP COLUMN "${columna}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "close_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "assigned_at"`,
    );
    // Postgres no quita valores de un enum: `sheet_closed`, `rescheduled`, `needs_reschedule`
    // y `route_sheet_watch` quedan (no molestan) y el historial se conserva.
  }
}
