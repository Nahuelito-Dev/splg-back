import { MigrationInterface, QueryRunner } from 'typeorm';

const ENUMS: Array<[tipo: string, tabla: string, columna: string]> = [
  ['cylinder_state_enum', 'cylinder', 'state'],
  ['cylinder_movement_from_state_enum', 'cylinder_movement', 'from_state'],
  ['cylinder_movement_to_state_enum', 'cylinder_movement', 'to_state'],
];

export class EnvaseDadoDeBaja1791100000000 implements MigrationInterface {
  name = 'EnvaseDadoDeBaja1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [tipo] of ENUMS) {
      await queryRunner.query(
        `ALTER TYPE "public"."${tipo}" ADD VALUE IF NOT EXISTS 'retired'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT (SELECT count(*) FROM "cylinder" WHERE "state" = 'retired')
            + (SELECT count(*) FROM "cylinder_movement"
                WHERE "to_state" = 'retired' OR "from_state" = 'retired') AS n`,
    );
    if (Number((filas as Array<{ n: string }>)[0].n) > 0) {
      throw new Error(
        'No se puede revertir: hay envases o movimientos en estado "retired"',
      );
    }
    for (const [tipo, tabla, columna] of ENUMS) {
      const viejo = `${tipo}_old`;
      await queryRunner.query(
        `ALTER TYPE "public"."${tipo}" RENAME TO "${viejo}"`,
      );
      await queryRunner.query(
        `CREATE TYPE "public"."${tipo}" AS ENUM('in_depot', 'filled', 'dispatched', 'with_customer', 'empty_returned')`,
      );
      if (tabla === 'cylinder') {
        await queryRunner.query(
          `ALTER TABLE "${tabla}" ALTER COLUMN "${columna}" DROP DEFAULT`,
        );
      }
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ALTER COLUMN "${columna}" TYPE "public"."${tipo}" USING "${columna}"::text::"public"."${tipo}"`,
      );
      if (tabla === 'cylinder') {
        await queryRunner.query(
          `ALTER TABLE "${tabla}" ALTER COLUMN "${columna}" SET DEFAULT 'in_depot'`,
        );
      }
      await queryRunner.query(`DROP TYPE "public"."${viejo}"`);
    }
  }
}
