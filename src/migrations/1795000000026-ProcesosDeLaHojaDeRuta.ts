import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hoja de ruta, etapa E3: los dos procesos automáticos de la planificación
 * (proponer el día siguiente al cierre y cerrar los días que llegaron) entran al
 * monitoreo.
 */
export class ProcesosDeLaHojaDeRuta1795000000026 implements MigrationInterface {
  name = 'ProcesosDeLaHojaDeRuta1795000000026';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'route_planning_propose'`,
    );
    await q.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'route_planning_close_days'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres no quita valores de un enum; los sobrantes no molestan y el
    // historial de corridas se conserva.
  }
}
