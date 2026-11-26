import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3a: cuántos días se corre la fecha estimada de recompra de un cliente en una
 * distribuidora, según el error de sus invitaciones anteriores. Acotado a ±15
 * días en la base.
 */
export class AjusteDeRecompraPorCliente1795000000241
  implements MigrationInterface
{
  name = 'AjusteDeRecompraPorCliente1795000000241';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "repurchase_offset" ("user_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "offset_days" integer NOT NULL DEFAULT '0', "sample_size" integer NOT NULL DEFAULT '0', "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_repurchase_offset_tope" CHECK ("offset_days" BETWEEN -15 AND 15 AND "sample_size" >= 0), CONSTRAINT "PK_repurchase_offset" PRIMARY KEY ("user_id", "distributor_id"))`,
    );
    await q.query(
      `CREATE INDEX "IDX_repurchase_offset_distributor" ON "repurchase_offset" ("distributor_id")`,
    );
    await q.query(
      `ALTER TABLE "repurchase_offset" ADD CONSTRAINT "FK_repurchase_offset_user" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "repurchase_offset" ADD CONSTRAINT "FK_repurchase_offset_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "repurchase_offset"`);
  }
}
