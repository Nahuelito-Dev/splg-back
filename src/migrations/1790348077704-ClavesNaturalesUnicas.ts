import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Claves naturales que el código daba por únicas y la base no garantizaba
 * (FNBC: todo determinante tiene que ser clave candidata): el tipo de producto
 * dentro de una distribuidora (H-88: la edición permitía duplicarlo), el tipo
 * de rol y la cuenta de Firebase de un usuario.
 */
export class ClavesNaturalesUnicas1790348077704 implements MigrationInterface {
  name = 'ClavesNaturalesUnicas1790348077704';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "role" ADD CONSTRAINT "UQ_9a0c91c218a16e604951ff1c099" UNIQUE ("type")`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD CONSTRAINT "UQ_40fe3048b17f675b652c1999270" UNIQUE ("firebase_uid")`,
    );
    // Si ya hay dos productos con el mismo tipo en una distribuidora, se
    // conserva el más antiguo y a los demás se les agrega un sufijo con su
    // identificador (en la base de desarrollo, un duplicado inactivo del 23/09).
    await queryRunner.query(
      `UPDATE "gas_cylinder" g
          SET "type" = left(g."type", 39) || ' (' || left(g."gas_cylinder_id"::text, 8) || ')'
        WHERE EXISTS (SELECT 1 FROM "gas_cylinder" o
                       WHERE o."distributor_id" = g."distributor_id"
                         AND o."type" = g."type"
                         AND (o."createdAt", o."gas_cylinder_id") < (g."createdAt", g."gas_cylinder_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD CONSTRAINT "UQ_gas_cylinder_distribuidora_tipo" UNIQUE ("distributor_id", "type")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP CONSTRAINT "UQ_gas_cylinder_distribuidora_tipo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP CONSTRAINT "UQ_40fe3048b17f675b652c1999270"`,
    );
    await queryRunner.query(
      `ALTER TABLE "role" DROP CONSTRAINT "UQ_9a0c91c218a16e604951ff1c099"`,
    );
  }
}
