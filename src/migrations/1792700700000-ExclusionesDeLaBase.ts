import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Solapamientos que la base impide con restricciones de exclusión
 * (`btree_gist`): dos operaciones al mismo tiempo ya no pueden dejar dos
 * franjas, jornadas, asignaciones de vehículo o reglas de comisión que se
 * pisen.
 *  - franjas horarias activas de una distribuidora (el borde compartido no
 *    cuenta: 8–10 y 10–12 conviven);
 *  - jornadas de un empleado (la abierta llega hasta «infinito»);
 *  - asignaciones de un vehículo y de un chofer;
 *  - reglas de comisión activas del mismo alcance (empleado y producto; sin
 *    empleado o sin producto = «todos»).
 */
export class ExclusionesDeLaBase1792700700000 implements MigrationInterface {
  name = 'ExclusionesDeLaBase1792700700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await queryRunner.query(
      `ALTER TABLE "time_slot" ADD CONSTRAINT "EXC_time_slot_solapada" EXCLUDE USING gist (
         "distributor_id" WITH =,
         tsrange(timestamp '2000-01-01' + "startTime", timestamp '2000-01-01' + "endTime") WITH &&
       ) WHERE ("isActive" AND "startTime" IS NOT NULL AND "endTime" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_attendance" ADD CONSTRAINT "EXC_employee_attendance_solapada" EXCLUDE USING gist (
         "employee_id" WITH =,
         tstzrange("check_in_at", COALESCE("check_out_at", 'infinity'::timestamptz)) WITH &&
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "EXC_vehicle_assignment_vehiculo_solapada" EXCLUDE USING gist (
         "car_id" WITH =,
         tstzrange("assigned_at", COALESCE("released_at", 'infinity'::timestamptz)) WITH &&
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "EXC_vehicle_assignment_chofer_solapada" EXCLUDE USING gist (
         "delivery_id" WITH =,
         tstzrange("assigned_at", COALESCE("released_at", 'infinity'::timestamptz)) WITH &&
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" ADD CONSTRAINT "EXC_commission_rule_solapada" EXCLUDE USING gist (
         "distributor_id" WITH =,
         COALESCE("employee_id", '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
         COALESCE("gas_cylinder_id", '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
         daterange("valid_from", "valid_to", '[]') WITH &&
       ) WHERE ("is_active")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, nombre] of [
      ['commission_rule', 'EXC_commission_rule_solapada'],
      ['vehicle_assignment', 'EXC_vehicle_assignment_chofer_solapada'],
      ['vehicle_assignment', 'EXC_vehicle_assignment_vehiculo_solapada'],
      ['employee_attendance', 'EXC_employee_attendance_solapada'],
      ['time_slot', 'EXC_time_slot_solapada'],
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${nombre}"`,
      );
    }
    // La extensión queda instalada: otras restricciones futuras pueden usarla.
  }
}
