import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tablero de tareas de flota, segunda vuelta (revisión 17/11):
 *
 * 1. Las posiciones del tablero de una empresa se escriben de a una: el
 *    trigger y el movimiento (`FleetTaskBoardService.mover`) toman el mismo
 *    cerrojo de transacción, `pg_advisory_xact_lock(hashtextextended(
 *    'fleet-board:' || distributor_id, 0))`. Dos altas o un alta y un
 *    movimiento ya no calculan el mismo «final de la columna».
 * 2. `TRG_maintenance_task_posicion_al_final` también corre `BEFORE UPDATE OF
 *    status, scheduled_at`: la tarea que cambia de columna por fuera del
 *    tablero (el planificador al programar, la póliza que se revierte) va al
 *    final de su columna nueva. Sólo para las columnas que se ordenan a mano
 *    (`forecast`, `scheduled`, `in_progress`): `done` se ordena por la fecha en
 *    que se hizo y `cancelled` no tiene columna, así que cerrar o cancelar no
 *    toma el cerrojo. El movimiento del tablero fija la posición él mismo y lo
 *    avisa con `set_config('splg.tablero_posicion', 'manual', true)` (sólo
 *    dura la transacción): el trigger no la pisa.
 */
const COLUMNA = (t: string) =>
  `CASE WHEN ${t}."status" = 'overdue' THEN CASE WHEN ${t}."scheduled_at" IS NULL THEN 'forecast' ELSE 'scheduled' END ELSE ${t}."status"::text END`;

export class PosicionesDelTableroSerializadas1795000000150
  implements MigrationInterface
{
  name = 'PosicionesDelTableroSerializadas1795000000150';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION maintenance_task_posicion_al_final() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE
         columna text := ${COLUMNA('NEW')};
         columna_anterior text;
       BEGIN
         IF TG_OP = 'INSERT' THEN
           IF NEW."board_position" IS NOT NULL THEN
             RETURN NEW;
           END IF;
         ELSE
           -- La columna anterior va en una variable: un CASE con THEN dentro de la
           -- condición de un IF corta el parser de PL/pgSQL.
           columna_anterior := ${COLUMNA('OLD')};
           IF columna = columna_anterior
              OR columna NOT IN ('forecast', 'scheduled', 'in_progress')
              OR coalesce(current_setting('splg.tablero_posicion', true), '') = 'manual' THEN
             RETURN NEW;
           END IF;
         END IF;
         PERFORM pg_advisory_xact_lock(hashtextextended('fleet-board:' || NEW."distributor_id"::text, 0));
         SELECT coalesce(max(t."board_position"), 0) + 1024
           INTO NEW."board_position"
           FROM "maintenance_task" t
          WHERE t."distributor_id" = NEW."distributor_id"
            AND t."task_id" <> NEW."task_id"
            AND ${COLUMNA('t')} = columna;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_maintenance_task_posicion_al_final" ON "maintenance_task"`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_maintenance_task_posicion_al_final" BEFORE INSERT OR UPDATE OF "status", "scheduled_at" ON "maintenance_task" FOR EACH ROW EXECUTE FUNCTION maintenance_task_posicion_al_final()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION maintenance_task_posicion_al_final() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."board_position" IS NULL THEN
           SELECT coalesce(max(t."board_position"), 0) + 1024
             INTO NEW."board_position"
             FROM "maintenance_task" t
            WHERE t."distributor_id" = NEW."distributor_id"
              AND ${COLUMNA('t')} = ${COLUMNA('NEW')};
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_maintenance_task_posicion_al_final" ON "maintenance_task"`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_maintenance_task_posicion_al_final" BEFORE INSERT ON "maintenance_task" FOR EACH ROW EXECUTE FUNCTION maintenance_task_posicion_al_final()`,
    );
  }
}
