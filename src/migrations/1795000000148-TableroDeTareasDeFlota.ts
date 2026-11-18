import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tablero de tareas de flota (17/11):
 *
 * 1. `maintenance_task.assignee_employee_id`: el responsable de la tarea (un
 *    empleado de la misma distribuidora: FK simple más la de tenant cruzado,
 *    `FK_maintenance_task_assignee_employee_distribuidora`).
 * 2. `maintenance_task.board_position`: el orden de la tarjeta dentro de su
 *    columna. Las tareas que ya existen se numeran por columna como las lista
 *    hoy el panel (vencimiento y después id), de a 1024.
 * 3. `TRG_maintenance_task_posicion_al_final`: una tarea que nace sin posición
 *    (cualquier camino de alta: el panel, la póliza, la lectura de un
 *    documento) entra al final de su columna. La columna de una `overdue` es
 *    la de su turno, igual que en `domain/task-board.ts`.
 * 4. `maintenance_task.updated_at`: la precondición del tablero.
 *
 * La auditoría de las columnas nuevas la instala la siguiente
 * (`AuditoriaDelTableroDeFlota`).
 */
const COLUMNA = (t: string) =>
  `CASE WHEN ${t}."status" = 'overdue' THEN CASE WHEN ${t}."scheduled_at" IS NULL THEN 'forecast' ELSE 'scheduled' END ELSE ${t}."status"::text END`;

export class TableroDeTareasDeFlota1795000000148 implements MigrationInterface {
  name = 'TableroDeTareasDeFlota1795000000148';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "assignee_employee_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "board_position" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `UPDATE "maintenance_task" t SET "board_position" = o."n" * 1024
       FROM (
         SELECT "task_id", row_number() OVER (
           PARTITION BY "distributor_id", ${COLUMNA('m')}
           ORDER BY "due_at" ASC NULLS LAST, "task_id" ASC
         ) AS "n"
         FROM "maintenance_task" m
       ) o
       WHERE o."task_id" = t."task_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ALTER COLUMN "board_position" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_task_assignee" ON "maintenance_task" ("assignee_employee_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_task_tablero" ON "maintenance_task" ("distributor_id", "status", "board_position") `,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_805741c8703d09621b1e6b63811" FOREIGN KEY ("assignee_employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_maintenance_task_assignee_employee_distribuidora" FOREIGN KEY ("assignee_employee_id", "distributor_id") REFERENCES "employee"("employee_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
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
      `CREATE TRIGGER "TRG_maintenance_task_posicion_al_final" BEFORE INSERT ON "maintenance_task" FOR EACH ROW EXECUTE FUNCTION maintenance_task_posicion_al_final()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_maintenance_task_posicion_al_final" ON "maintenance_task"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS maintenance_task_posicion_al_final()`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_maintenance_task_assignee_employee_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_805741c8703d09621b1e6b63811"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_maintenance_task_tablero"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_maintenance_task_assignee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "updated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "board_position"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "assignee_employee_id"`,
    );
  }
}
