import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El back guarda y busca el serial del envase en su forma canónica (sin
 * espacios en los bordes y en mayúsculas). Los envases cargados antes de esa
 * regla se normalizan acá, para que la asignación los encuentre.
 *
 * Si la forma canónica de un envase ya la tiene otro de la misma distribuidora,
 * el envase NO se toca y queda avisado en el log de la migración (hay que
 * decidir a mano cuál se conserva); el índice `UQ_cylinder_serial_normalizado`
 * usa la misma expresión, así que en la práctica no debería haber choques.
 */
export class NormalizarSerialesDeEnvase1792701100000
  implements MigrationInterface
{
  name = 'NormalizarSerialesDeEnvase1792701100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Misma expresión que `UQ_cylinder_serial_normalizado` y que `normalizarSerial`.
    const canonico = (alias: string): string =>
      `upper(btrim(${alias}."serial"))`;

    const enChoque = (await queryRunner.query(
      `SELECT c."cylinder_id", c."serial" FROM "cylinder" c
        WHERE c."serial" <> ${canonico('c')} AND ${canonico('c')} <> ''
          AND EXISTS (
            SELECT 1 FROM "cylinder" o
             WHERE o."cylinder_id" <> c."cylinder_id"
               AND o."distributor_id" = c."distributor_id"
               AND ${canonico('o')} = ${canonico('c')})`,
    )) as Array<{ cylinder_id: string; serial: string }>;
    if (enChoque.length > 0) {
      console.warn(
        `NormalizarSerialesDeEnvase: ${enChoque.length} envase(s) quedan sin normalizar porque otro de su distribuidora ya tiene ese serial: ${enChoque
          .map((e) => `${e.cylinder_id} («${e.serial}»)`)
          .join(', ')}`,
      );
    }

    await queryRunner.query(
      `UPDATE "cylinder" c SET "serial" = ${canonico('c')}
        WHERE c."serial" <> ${canonico('c')} AND ${canonico('c')} <> ''
          AND NOT EXISTS (
            SELECT 1 FROM "cylinder" o
             WHERE o."cylinder_id" <> c."cylinder_id"
               AND o."distributor_id" = c."distributor_id"
               AND ${canonico('o')} = ${canonico('c')})`,
    );
  }

  public async down(): Promise<void> {
    // Datos normalizados: no se pueden volver a los valores anteriores.
  }
}
