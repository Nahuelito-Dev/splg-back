import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 2 (API v2): todo gasto de la flota es un egreso de caja,
 * primera parte: los valores nuevos de los enums. Va aparte de las columnas
 * porque un valor de enum agregado no se puede usar en la misma transacción que
 * lo agrega (las categorías se siembran en `GastosDeFlotaPago`).
 *
 * - `cash_category.system_code`: «Mantenimiento de flota», «Neumáticos»,
 *   «Siniestros» (egresos) y «Reintegros de seguros» (ingreso).
 * - `cash_movement.reference_type`: de qué gasto nace el movimiento.
 */
export class GastosDeFlotaEnumsDeCaja1793900000000
  implements MigrationInterface
{
  name = 'GastosDeFlotaEnumsDeCaja1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const codigo of [
      'fleet_maintenance',
      'tires',
      'vehicle_accident',
      'insurance_reimbursement',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."cash_category_system_code_enum" ADD VALUE IF NOT EXISTS '${codigo}'`,
      );
    }
    for (const origen of [
      'maintenance_task',
      'tire',
      'vehicle_accident',
      'insurance_reimbursement',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."cash_movement_reference_type_enum" ADD VALUE IF NOT EXISTS '${origen}'`,
      );
    }
  }

  /**
   * Aborta antes de tocar nada si hay movimientos con los valores nuevos: esa
   * historia no se descarta sola. Las categorías sin movimientos se quitan,
   * como las demás categorías de sistema. Los valores del enum quedan: Postgres
   * no permite quitarlos y son inocuos.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const usos: unknown = await queryRunner.query(
      `SELECT count(*) AS movimientos FROM "cash_movement"
       WHERE "reference_type" IN ('maintenance_task', 'tire', 'vehicle_accident', 'insurance_reimbursement')`,
    );
    const { movimientos } = (usos as Array<{ movimientos: string }>)[0];
    if (Number(movimientos) > 0) {
      throw new Error(
        `No se puede revertir: hay ${movimientos} movimientos de caja de gastos de la flota`,
      );
    }
    await queryRunner.query(
      `DELETE FROM "cash_category" WHERE "system_code" IN ('fleet_maintenance', 'tires', 'vehicle_accident', 'insurance_reimbursement')`,
    );
  }
}
