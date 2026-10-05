import { MigrationInterface, QueryRunner } from 'typeorm';

export class CrearPersonal1791159476552 implements MigrationInterface {
  name = 'CrearPersonal1791159476552';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."job_position_category_enum" AS ENUM('driver', 'helper', 'warehouse', 'administration', 'sales', 'management', 'other')`,
    );
    await queryRunner.query(
      `CREATE TABLE "job_position" ("position_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(80) NOT NULL, "category" "public"."job_position_category_enum" NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_b76336b3450074bc7b4aa846b1e" PRIMARY KEY ("position_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f63c2b78c253c8c92398d88fd5" ON "job_position" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_job_position_name_vigente" ON "job_position" ("distributor_id", lower("name")) WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."employee_document_type_enum" AS ENUM('dni', 'passport', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."employee_termination_reason_enum" AS ENUM('resignation', 'dismissal', 'end_of_contract', 'retirement', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."employment_type_enum" AS ENUM('permanent', 'fixed_term', 'part_time', 'contractor')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."employee_status_enum" AS ENUM('active', 'terminated')`,
    );
    await queryRunner.query(
      `CREATE TABLE "employee" ("employee_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "user_id" uuid, "position_id" uuid NOT NULL, "file_number" character varying(20) NOT NULL, "first_name" character varying(80) NOT NULL, "last_name" character varying(80) NOT NULL, "document_type" "public"."employee_document_type_enum" NOT NULL, "document_number" character varying(20) NOT NULL, "cuil" character varying(11), "birth_date" date, "address_line" character varying(200), "city" character varying(80), "province" character varying(80), "postal_code" character varying(10), "phone" character varying(30), "personal_email" character varying(120), "emergency_contact_name" character varying(120), "emergency_contact_phone" character varying(30), "emergency_contact_relationship" character varying(40), "hire_date" date NOT NULL, "termination_date" date, "termination_reason" "public"."employee_termination_reason_enum", "employment_type" "public"."employment_type_enum" NOT NULL, "status" "public"."employee_status_enum" NOT NULL DEFAULT 'active', "bank_cbu" character varying(22), "notes" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_employee_status_termination" CHECK (("status" = 'terminated') = ("termination_date" IS NOT NULL)), CONSTRAINT "CHK_employee_termination_date" CHECK ("termination_date" IS NULL OR "termination_date" >= "hire_date"), CONSTRAINT "PK_f9d306b968b54923539b3936b03" PRIMARY KEY ("employee_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_position" ON "employee" ("position_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_name" ON "employee" ("distributor_id", "last_name", "first_name") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_status" ON "employee" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_employee_cuil_vigente" ON "employee" ("distributor_id", "cuil") WHERE "cuil" IS NOT NULL AND "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_employee_document_vigente" ON "employee" ("distributor_id", "document_number") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_employee_file_number_vigente" ON "employee" ("distributor_id", "file_number") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_employee_user_vigente" ON "employee" ("user_id") WHERE "user_id" IS NOT NULL AND "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_position" ADD CONSTRAINT "FK_f63c2b78c253c8c92398d88fd59" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee" ADD CONSTRAINT "FK_498ca175e44d448913f05298825" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee" ADD CONSTRAINT "FK_f61258e58ed35475ce1dba03797" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee" ADD CONSTRAINT "FK_6ab3ec557a640017d53ac0e0ab7" FOREIGN KEY ("position_id") REFERENCES "job_position"("position_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "employee" DROP CONSTRAINT "FK_6ab3ec557a640017d53ac0e0ab7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee" DROP CONSTRAINT "FK_f61258e58ed35475ce1dba03797"`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee" DROP CONSTRAINT "FK_498ca175e44d448913f05298825"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_position" DROP CONSTRAINT "FK_f63c2b78c253c8c92398d88fd59"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_employee_user_vigente"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_employee_file_number_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_employee_document_vigente"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_employee_cuil_vigente"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_employee_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_employee_name"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_employee_position"`);
    await queryRunner.query(`DROP TABLE "employee"`);
    await queryRunner.query(`DROP TYPE "public"."employee_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."employment_type_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."employee_termination_reason_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."employee_document_type_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_job_position_name_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f63c2b78c253c8c92398d88fd5"`,
    );
    await queryRunner.query(`DROP TABLE "job_position"`);
    await queryRunner.query(`DROP TYPE "public"."job_position_category_enum"`);
  }
}
