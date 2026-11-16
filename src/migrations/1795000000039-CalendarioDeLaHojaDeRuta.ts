import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Días hábiles de la hoja de ruta por distribuidora (F34):
 *  - parámetro `workingDays` de `route_planning` (máscara de bits de los días
 *    ISO, 1 a 127; por omisión 63 = lunes a sábado) en su CHECK;
 *  - tabla `route_planning_holiday`: feriados por distribuidora y fecha, con
 *    baja lógica y un solo feriado vigente por día (índice único parcial).
 *
 * La propuesta automática no arma un plan para un día no hábil y la
 * reprogramación de un pedido los saltea. El mapa de auditoría con la tabla
 * nueva lo aplica la migración siguiente (`AuditoriaDeLaEjecucionDeLaHoja`).
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
  ['arrivalWaitMinutes', 1, 60],
];
const RANGOS_NUEVOS: ReadonlyArray<[string, number, number]> = [
  ...RANGOS_ANTERIORES,
  ['workingDays', 1, 127],
];

const checkDeLaHoja = (rangos: ReadonlyArray<[string, number, number]>) =>
  `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_hoja_de_ruta" CHECK ("module"::text <> 'route_planning' OR (${rangos
    .map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'trafficFactor' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
    )
    .join(' AND ')}))`;

export class CalendarioDeLaHojaDeRuta1795000000039
  implements MigrationInterface
{
  name = 'CalendarioDeLaHojaDeRuta1795000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "route_planning_holiday" ("holiday_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "holiday_date" date NOT NULL, "description" character varying(120) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_route_planning_holiday_descripcion" CHECK (char_length(btrim("description")) >= 2), CONSTRAINT "PK_19b122232c9254276f79dfe8fb0" PRIMARY KEY ("holiday_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_446f490009c260feb8b84273d9" ON "route_planning_holiday" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_planning_holiday_vigente" ON "route_planning_holiday" ("distributor_id", "holiday_date") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_planning_holiday" ADD CONSTRAINT "FK_446f490009c260feb8b84273d93" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_NUEVOS));
  }

  /**
   * DESTRUCTIVO: borra los feriados cargados y el parámetro `workingDays` de
   * cada distribuidora. Sólo para desarrollo.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(
      `UPDATE "module_config" SET "params" = "params" - 'workingDays' WHERE "module"::text = 'route_planning'`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_ANTERIORES));
    await queryRunner.query(
      `ALTER TABLE "route_planning_holiday" DROP CONSTRAINT "FK_446f490009c260feb8b84273d93"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_route_planning_holiday_vigente"`);
    await queryRunner.query(`DROP INDEX "IDX_446f490009c260feb8b84273d9"`);
    await queryRunner.query(`DROP TABLE "route_planning_holiday"`);
  }
}
