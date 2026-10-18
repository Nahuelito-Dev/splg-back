import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal, tanda 2 (CU-183 a CU-185, CU-187 a CU-194, CU-246, CU-313 a CU-319):
 *
 * - Documentación del personal sobre las tablas de flota: el sujeto `employee`
 *   en los planes, `document_kind` y `applies_to_categories` en el plan,
 *   `employee_id` y `details` en la tarea. Se siembran los planes «Curso de
 *   transporte de mercancías peligrosas (GLP)», «Examen psicofísico» y «Alta en
 *   ART» para las distribuidoras que ya existen (las nuevas los reciben por el
 *   evento `distribuidora.creada`); y se completan `document_kind` y
 *   `applies_to_categories` de los 4 planes base anteriores.
 * - Asistencia (`employee_attendance`, una sola jornada abierta por empleado) y
 *   licencias (`employee_leave`).
 * - Trigger `employee_leave_no_overlap`: dos licencias solicitadas o aprobadas
 *   del mismo empleado no se pisan ni aunque las cargue alguien por fuera del
 *   servicio; toma un lock de aviso (dos claves: espacio `employee_leave` y empleado) para que dos transacciones
 *   simultáneas se serialicen.
 *
 * MISMOS valores que `fleet/domain/base-plans.ts`: si se cambia uno, se cambia
 * en los dos lados.
 */
export class DocumentacionAsistenciaYLicenciasDelPersonal1792080000000
  implements MigrationInterface
{
  name = 'DocumentacionAsistenciaYLicenciasDelPersonal1792080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."employee_leave_type_enum" AS ENUM('vacation', 'sick', 'work_accident', 'study', 'marriage', 'birth', 'bereavement', 'unpaid', 'suspension', 'unjustified_absence', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."employee_leave_status_enum" AS ENUM('requested', 'approved', 'rejected', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "employee_leave" ("leave_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "employee_id" uuid NOT NULL, "type" "public"."employee_leave_type_enum" NOT NULL, "start_date" date NOT NULL, "end_date" date NOT NULL, "days" integer NOT NULL, "status" "public"."employee_leave_status_enum" NOT NULL DEFAULT 'requested', "reason" text, "rejection_reason" text, "requested_by_user_id" uuid, "decided_by_user_id" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_employee_leave_period" CHECK ("end_date" >= "start_date"), CONSTRAINT "PK_84fc148f29a528aa770fb590a1f" PRIMARY KEY ("leave_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_leave_distributor" ON "employee_leave" ("distributor_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_leave_employee" ON "employee_leave" ("employee_id", "status", "start_date", "end_date")`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."employee_attendance_source_enum" AS ENUM('panel', 'driver_app')`,
    );
    await queryRunner.query(
      `CREATE TABLE "employee_attendance" ("attendance_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "employee_id" uuid NOT NULL, "work_date" date NOT NULL, "check_in_at" TIMESTAMP WITH TIME ZONE NOT NULL, "check_out_at" TIMESTAMP WITH TIME ZONE, "source" "public"."employee_attendance_source_enum" NOT NULL, "recorded_by_user_id" uuid, "notes" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_employee_attendance_period" CHECK ("check_out_at" IS NULL OR "check_out_at" > "check_in_at"), CONSTRAINT "PK_ba49c1b4279ee383655a5065e06" PRIMARY KEY ("attendance_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_attendance_employee" ON "employee_attendance" ("employee_id", "work_date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_attendance_day" ON "employee_attendance" ("distributor_id", "work_date")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_employee_attendance_abierta" ON "employee_attendance" ("employee_id") WHERE "check_out_at" IS NULL`,
    );
    await this.tipoDeDocumento(queryRunner);
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" ADD "applies_to_categories" character varying array`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "employee_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "details" jsonb`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."maintenance_subject_enum" RENAME TO "maintenance_subject_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_subject_enum" AS ENUM('vehicle', 'driver', 'employee')`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" ALTER COLUMN "subject" TYPE "public"."maintenance_subject_enum" USING "subject"::"text"::"public"."maintenance_subject_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."maintenance_subject_enum_old"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_task_employee" ON "maintenance_task" ("employee_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_leave" ADD CONSTRAINT "FK_b8923c061b86827456de74e7ea8" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_leave" ADD CONSTRAINT "FK_a7720c43add56423460fa1a2aaa" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_leave" ADD CONSTRAINT "FK_d417e890ac4cb96aaa6da2fb239" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_leave" ADD CONSTRAINT "FK_0c529fe51d5cdcf84876085d637" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_8358c952b2c0b0dab8df7965f83" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_attendance" ADD CONSTRAINT "FK_2f436573780c5731f76c5833944" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_attendance" ADD CONSTRAINT "FK_4ea40b73b24bf50777c9601f180" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_attendance" ADD CONSTRAINT "FK_e8e6684056188b645f01dc2f24e" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`
      UPDATE "maintenance_plan" SET "document_kind" = v.kind::"public"."plan_document_kind_enum",
             "applies_to_categories" = v.categorias
      FROM (VALUES
        ('Seguro del vehículo', 'vehicle', 'insurance', NULL::varchar[]),
        ('VTV', 'vehicle', 'vtv', NULL::varchar[]),
        ('Licencia de conducir', 'driver', 'driver_license', ARRAY['driver']::varchar[]),
        ('Service / cambio de aceite', 'vehicle', 'service', NULL::varchar[])
      ) AS v(name, subject, kind, categorias)
      WHERE "maintenance_plan"."name" = v.name
        AND "maintenance_plan"."subject"::text = v.subject
        AND "maintenance_plan"."document_kind" IS NULL
    `);

    await queryRunner.query(`
      INSERT INTO "maintenance_plan"
        ("plan_id", "distributor_id", "name", "subject", "trigger", "interval_km", "interval_months", "lead_time_days", "criticality", "car_type", "document_kind", "applies_to_categories", "is_active")
      SELECT
        uuid_generate_v4(), d."distributor_id", v.name, 'employee'::"public"."maintenance_subject_enum", 'by_fixed_date'::"maintenance_trigger_enum",
        NULL, NULL, v.lead_time_days, v.criticality::"maintenance_criticality_enum", NULL,
        v.kind::"public"."plan_document_kind_enum", v.categorias, true
      FROM "distributor" d
      CROSS JOIN (VALUES
        ('Curso de transporte de mercancías peligrosas (GLP)', 60, 'blocking', 'hazmat_driver_course', ARRAY['driver']::varchar[]),
        ('Examen psicofísico', 30, 'blocking', 'psychophysical', ARRAY['driver']::varchar[]),
        ('Alta en ART', 30, 'non_blocking', 'art_coverage', NULL::varchar[])
      ) AS v(name, lead_time_days, criticality, kind, categorias)
      WHERE NOT EXISTS (
        SELECT 1 FROM "maintenance_plan" mp
        WHERE mp."distributor_id" = d."distributor_id" AND mp."name" = v.name
          AND mp."subject"::text = 'employee'
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "employee_leave_no_overlap"() RETURNS trigger AS $$
      BEGIN
        IF NEW."status" IN ('requested', 'approved') THEN
          PERFORM pg_advisory_xact_lock(hashtext('employee_leave'), hashtext(NEW."employee_id"::text));
          IF EXISTS (
            SELECT 1 FROM "employee_leave" l
            WHERE l."employee_id" = NEW."employee_id"
              AND l."leave_id" <> NEW."leave_id"
              AND l."status" IN ('requested', 'approved')
              AND l."start_date" <= NEW."end_date"
              AND l."end_date" >= NEW."start_date"
          ) THEN
            RAISE EXCEPTION 'La licencia se superpone con otra del mismo empleado'
              USING ERRCODE = '23P01';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "employee_leave_no_overlap"
      BEFORE INSERT OR UPDATE ON "employee_leave"
      FOR EACH ROW EXECUTE FUNCTION "employee_leave_no_overlap"()
    `);
  }

  /**
   * `maintenance_plan.document_kind` con todos los tipos de documento. Otra
   * tanda (flota ampliada) crea la misma columna con el mismo tipo
   * `plan_document_kind_enum` y menos valores: si ya existe se amplía el tipo
   * (rename/create/alter, que se puede usar en esta misma transacción); si no,
   * se crea todo.
   */
  private async tipoDeDocumento(queryRunner: QueryRunner): Promise<void> {
    const VALORES = `'insurance', 'vtv', 'hazmat_vehicle_permit', 'driver_license', 'hazmat_driver_course', 'psychophysical', 'art_coverage', 'service', 'generic'`;
    const existe: unknown = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'maintenance_plan' AND column_name = 'document_kind'`,
    );
    if ((existe as unknown[]).length === 0) {
      await queryRunner.query(
        `CREATE TYPE "public"."plan_document_kind_enum" AS ENUM(${VALORES})`,
      );
      await queryRunner.query(
        `ALTER TABLE "maintenance_plan" ADD "document_kind" "public"."plan_document_kind_enum"`,
      );
      return;
    }
    await queryRunner.query(
      `ALTER TYPE "public"."plan_document_kind_enum" RENAME TO "plan_document_kind_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."plan_document_kind_enum" AS ENUM(${VALORES})`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" ALTER COLUMN "document_kind" TYPE "public"."plan_document_kind_enum" USING "document_kind"::"text"::"public"."plan_document_kind_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."plan_document_kind_enum_old"`);
  }

  /**
   * Deshace `document_kind`. Si la flota ampliada (FlotaAmpliada1792186500123)
   * está aplicada, la columna es de las dos migraciones —en una base donde la
   * flota corrió antes que esta, se revierte esta primero—: se deja y el tipo
   * vuelve a los tres valores de flota. Antes se limpia lo que esta migración
   * completó en los planes base; si queda algún plan con un tipo del personal,
   * se frena con un mensaje claro en vez de perderlo.
   */
  private async bajarTipoDeDocumento(queryRunner: QueryRunner): Promise<void> {
    const flota = (await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'car' AND column_name = 'fuel_type'`,
    )) as unknown[];
    if (flota.length === 0) {
      await queryRunner.query(
        `ALTER TABLE "maintenance_plan" DROP COLUMN "document_kind"`,
      );
      await queryRunner.query(`DROP TYPE "public"."plan_document_kind_enum"`);
      return;
    }
    await queryRunner.query(`
      UPDATE "maintenance_plan" SET "document_kind" = NULL
      WHERE ("name" = 'Licencia de conducir' AND "document_kind"::text = 'driver_license')
         OR ("name" = 'Service / cambio de aceite' AND "document_kind"::text = 'service')
    `);
    const otros = (await queryRunner.query(
      `SELECT count(*) AS n FROM "maintenance_plan" WHERE "document_kind"::text NOT IN ('insurance', 'vtv', 'hazmat_vehicle_permit')`,
    )) as Array<{ n: string }>;
    if (Number(otros[0].n) > 0) {
      throw new Error(
        'No se puede revertir: hay planes de flota con un tipo de documento del personal (maintenance_plan.document_kind); cambialos o desactivalos antes',
      );
    }
    await queryRunner.query(
      `ALTER TYPE "public"."plan_document_kind_enum" RENAME TO "plan_document_kind_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."plan_document_kind_enum" AS ENUM('insurance', 'vtv', 'hazmat_vehicle_permit')`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" ALTER COLUMN "document_kind" TYPE "public"."plan_document_kind_enum" USING "document_kind"::"text"::"public"."plan_document_kind_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."plan_document_kind_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "maintenance_task" WHERE "employee_id" IS NOT NULL`,
    );
    if (Number((filas as Array<{ n: string }>)[0].n) > 0) {
      throw new Error(
        'No se puede revertir: hay documentación de personal cargada (maintenance_task.employee_id)',
      );
    }
    const jornadas: unknown = await queryRunner.query(
      `SELECT (SELECT count(*) FROM "employee_attendance")
            + (SELECT count(*) FROM "employee_leave") AS n`,
    );
    if (Number((jornadas as Array<{ n: string }>)[0].n) > 0) {
      throw new Error(
        'No se puede revertir: hay jornadas o licencias cargadas (employee_attendance, employee_leave)',
      );
    }
    await queryRunner.query(
      `DROP TRIGGER "employee_leave_no_overlap" ON "employee_leave"`,
    );
    await queryRunner.query(`DROP FUNCTION "employee_leave_no_overlap"()`);
    await queryRunner.query(
      `DELETE FROM "maintenance_plan" WHERE "subject"::text = 'employee'`,
    );
    await queryRunner.query(`DROP TABLE "employee_attendance"`);
    await queryRunner.query(
      `DROP TYPE "public"."employee_attendance_source_enum"`,
    );
    await queryRunner.query(`DROP TABLE "employee_leave"`);
    await queryRunner.query(`DROP TYPE "public"."employee_leave_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."employee_leave_type_enum"`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_8358c952b2c0b0dab8df7965f83"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_maintenance_task_employee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "details"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "employee_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" DROP COLUMN "applies_to_categories"`,
    );
    await this.bajarTipoDeDocumento(queryRunner);
    await queryRunner.query(
      `ALTER TYPE "public"."maintenance_subject_enum" RENAME TO "maintenance_subject_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_subject_enum" AS ENUM('vehicle', 'driver')`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" ALTER COLUMN "subject" TYPE "public"."maintenance_subject_enum" USING "subject"::"text"::"public"."maintenance_subject_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."maintenance_subject_enum_old"`,
    );
  }
}
