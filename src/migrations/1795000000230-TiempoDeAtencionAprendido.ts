import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tiempo de atención aprendido (M4):
 *  - tabla `route_service_time_stat`: una fila por distribuidora con la mediana
 *    y el p90 de «Llegué» a la entrega de los últimos 30 días;
 *  - `serviceMinutesMode` (0 fijo, 1 aprendido) de `route_planning` en su CHECK.
 *    No hay valor que migrar: sin la clave rige el fijo;
 *  - proceso `route_service_time_learn` en el monitoreo (cálculo nocturno).
 */
/** Rangos de los parámetros de la hoja de ruta antes de esta migración (copia congelada). */
const RANGOS_ANTERIORES: ReadonlyArray<[string, number, number]> = [
  ['enabled', 0, 1],
  ['cutoffHour', 0, 23],
  ['cutoffMinute', 0, 59],
  ['autoPropose', 0, 1],
  ['autoConfirm', 0, 1],
  ['reviewMinutes', 0, 720],
  ['maxStopsPerSheet', 2, 40],
  ['serviceMinutes', 1, 60],
  ['trafficFactor', 1, 3],
  ['etaWindowMinutes', 10, 120],
  ['etaRecalcMinSeconds', 30, 900],
  ['etaRecalcMinMeters', 50, 5000],
  ['etaNotifyShiftMinutes', 5, 120],
  ['lateOrderPolicy', 0, 1],
  ['notStartedAlertMinutes', 0, 240],
  ['arrivalWaitMinutes', 1, 60],
  ['workingDays', 1, 127],
];
const RANGOS_NUEVOS: ReadonlyArray<[string, number, number]> = [
  ...RANGOS_ANTERIORES,
  ['serviceMinutesMode', 0, 1],
];

const checkDeLaHoja = (rangos: ReadonlyArray<[string, number, number]>) =>
  `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_hoja_de_ruta" CHECK ("module"::text <> 'route_planning' OR (${rangos
    .map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'trafficFactor' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
    )
    .join(' AND ')}))`;

export class TiempoDeAtencionAprendido1795000000230
  implements MigrationInterface
{
  name = 'TiempoDeAtencionAprendido1795000000230';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "route_service_time_stat" ("stat_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "samples" integer NOT NULL, "median_min" numeric(5,2), "p90_min" numeric(5,2), "window_days" smallint NOT NULL, "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_route_service_time_stat_minutos" CHECK (("median_min" IS NULL) = ("p90_min" IS NULL) AND ("median_min" IS NULL OR ("median_min" BETWEEN 1 AND 60 AND "p90_min" BETWEEN "median_min" AND 60))), CONSTRAINT "CHK_route_service_time_stat_muestras" CHECK ("samples" >= 0), CONSTRAINT "PK_route_service_time_stat" PRIMARY KEY ("stat_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_service_time_stat_distribuidora" ON "route_service_time_stat" ("distributor_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "route_service_time_stat" ADD CONSTRAINT "FK_49d9d0de1d31fdfc1e8ab15243f" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_NUEVOS));
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'route_service_time_learn'`,
    );
  }

  /**
   * Repone el CHECK anterior; un `serviceMinutesMode` ya guardado no lo viola
   * (sólo restringe las claves que lista) y el esquema viejo lo ignora. El valor
   * del enum de procesos queda (Postgres no quita valores) y el historial se conserva.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_ANTERIORES));
    await queryRunner.query(
      `ALTER TABLE "route_service_time_stat" DROP CONSTRAINT "FK_49d9d0de1d31fdfc1e8ab15243f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_route_service_time_stat_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "route_service_time_stat"`);
  }
}
