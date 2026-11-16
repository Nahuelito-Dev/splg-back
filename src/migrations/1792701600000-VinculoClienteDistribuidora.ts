import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Un cliente dado de alta por una distribuidora desde el panel le pertenece
 * aunque todavía no tenga pedidos: `customer_distributor` guarda ese vínculo
 * (clave compuesta, sin duplicados). La pertenencia por pedidos no cambia.
 */
export class VinculoClienteDistribuidora1792701600000
  implements MigrationInterface
{
  name = 'VinculoClienteDistribuidora1792701600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "customer_distributor" (
         "user_id" uuid NOT NULL,
         "distributor_id" uuid NOT NULL,
         "created_by_user_id" uuid,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_customer_distributor" PRIMARY KEY ("user_id", "distributor_id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_distributor_distributor" ON "customer_distributor" ("distributor_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD CONSTRAINT "FK_customer_distributor_user" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD CONSTRAINT "FK_customer_distributor_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD CONSTRAINT "FK_customer_distributor_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "customer_distributor"`);
  }
}
