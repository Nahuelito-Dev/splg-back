import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Confirmación automática de la hoja de ruta (F34): parámetros `autoConfirm`
 * (0 o 1) y `reviewMinutes` (0 a 720) de `route_planning` en su CHECK.
 *
 * Que la hoja venga encendida (`enabled` por omisión 1) no toca la base: el
 * valor por omisión vive en el esquema de parámetros, y una distribuidora que
 * guardó `enabled` conserva lo que guardó. No hay columnas nuevas, así que el
 * mapa de la auditoría no cambia.
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
  ['workingDays', 1, 127],
];
const RANGOS_NUEVOS: ReadonlyArray<[string, number, number]> = [
  ...RANGOS_ANTERIORES,
  ['autoConfirm', 0, 1],
  ['reviewMinutes', 0, 720],
];

const checkDeLaHoja = (rangos: ReadonlyArray<[string, number, number]>) =>
  `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_hoja_de_ruta" CHECK ("module"::text <> 'route_planning' OR (${rangos
    .map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'trafficFactor' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
    )
    .join(' AND ')}))`;

export class ConfirmacionAutomaticaDeLaHoja1795000000041
  implements MigrationInterface
{
  name = 'ConfirmacionAutomaticaDeLaHoja1795000000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_NUEVOS));
  }

  /**
   * Repone el CHECK anterior y deja los parámetros como están: el CHECK viejo
   * sólo restringe las claves que lista (cada una `IS NULL OR …`), así que
   * `autoConfirm` y `reviewMinutes` guardados no lo violan y no hace falta
   * borrarlos (el esquema de la versión anterior los ignora al leer).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(checkDeLaHoja(RANGOS_ANTERIORES));
  }
}
