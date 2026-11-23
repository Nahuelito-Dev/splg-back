import { MigrationInterface, QueryRunner } from 'typeorm';

const RANGOS: ReadonlyArray<[string, number, number]> = [
  ['enabled', 0, 1],
  ['closeHour', 0, 23],
  ['minHours', 1, 720],
];
const CHECK = RANGOS.map(
  ([k, min, max]) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
).join(' AND ');

/**
 * Aviso del efectivo cobrado y no rendido (C4): el proceso configurable
 * `cash_alerts` (hora del cierre y antigüedad en horas) y el proceso
 * `driver_cash_alert` del monitoreo. Los valores nuevos de enum no se pueden
 * quitar en `down` (Postgres no lo permite): sobran sin molestar.
 */
export class AvisoDelEfectivoSinRendir1795000000163
  implements MigrationInterface
{
  name = 'AvisoDelEfectivoSinRendir1795000000163';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "configurable_process_enum" ADD VALUE IF NOT EXISTS 'cash_alerts'`,
    );
    await q.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'driver_cash_alert'`,
    );
    await q.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_aviso_efectivo" CHECK ("module"::text <> 'cash_alerts' OR (${CHECK}))`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_aviso_efectivo"`,
    );
    await q.query(
      `DELETE FROM "module_config" WHERE "module"::text = 'cash_alerts'`,
    );
    await q.query(
      `DELETE FROM "process_run" WHERE "process"::text = 'driver_cash_alert'`,
    );
  }
}
