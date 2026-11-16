import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normaliza las patentes existentes (mayúsculas, sin espacios ni guiones), la
 * misma regla que aplica `CarService` al guardar. La unicidad vale entre los
 * vehículos vigentes (`UQ_car_patente_vigente`): una patente que al
 * normalizarse chocaría con otra vigente NO se toca y se informa por consola
 * para que alguien decida a mano; nada se borra.
 *
 * `down` no restaura el formato anterior (no se conserva): es irreversible
 * a propósito y no hace nada.
 */
export class NormalizarPatentes1790900000000 implements MigrationInterface {
  name = 'NormalizarPatentes1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(`
        SELECT upper(regexp_replace("car_patent", '[\\s-]', '', 'g')) AS patente,
               array_agg("car_id"::text) AS ids
        FROM "car"
        WHERE "deletedAt" IS NULL AND "car_patent" IS NOT NULL
        GROUP BY 1
        HAVING count(*) > 1
      `);
    const choques = filas as Array<{ patente: string; ids: string[] }>;
    for (const choque of choques) {
      console.warn(
        `[NormalizarPatentes] ${choque.patente} está repetida entre los vehículos vigentes ${choque.ids.join(', ')}: no se normalizan`,
      );
    }

    await queryRunner.query(`
      UPDATE "car" c
      SET "car_patent" = upper(regexp_replace(c."car_patent", '[\\s-]', '', 'g'))
      WHERE c."car_patent" IS NOT NULL
        AND c."car_patent" <> upper(regexp_replace(c."car_patent", '[\\s-]', '', 'g'))
        AND (
          c."deletedAt" IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM "car" o
            WHERE o."deletedAt" IS NULL
              AND o."car_id" <> c."car_id"
              AND upper(regexp_replace(o."car_patent", '[\\s-]', '', 'g'))
                = upper(regexp_replace(c."car_patent", '[\\s-]', '', 'g'))
          )
        )
    `);
  }

  public async down(): Promise<void> {
    // Irreversible a propósito: la migración sobrescribe el valor y no guarda
    // cómo estaba escrita cada patente ("ab 123-cd" vs "AB123CD"), así que no
    // hay de dónde restaurarlo. Revertirla no rompe nada: las patentes ya
    // normalizadas siguen siendo válidas con el código anterior.
  }
}
