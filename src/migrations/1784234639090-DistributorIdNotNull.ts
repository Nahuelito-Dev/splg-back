import { MigrationInterface, QueryRunner } from "typeorm";

export class DistributorIdNotNull1784234639090 implements MigrationInterface {
    name = 'DistributorIdNotNull1784234639090'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // --- Backfill de distributor_id NULL (data pre-multi-tenant) ANTES de
        //     imponer NOT NULL, si no el ALTER falla ---
        // Las ofertas de despacho toman el tenant de SU pedido.
        await queryRunner.query(
            `UPDATE "order_dispatch_offer" o SET distributor_id = ord.distributor_id
             FROM "order" ord WHERE ord.order_id = o.order_id AND o.distributor_id IS NULL`,
        );
        // El resto de los NULL → distribuidora default (la más antigua, misma
        // lógica que DistributorService.getDefault).
        const DEF = `(SELECT distributor_id FROM distributor ORDER BY "createdAt" ASC LIMIT 1)`;
        for (const t of [
            'order', 'gas_cylinder', 'delivery', 'car', 'time_slot',
            'claims', 'incident', 'rating', 'order_dispatch_offer',
        ]) {
            await queryRunner.query(
                `UPDATE "${t}" SET distributor_id = ${DEF} WHERE distributor_id IS NULL`,
            );
        }

        await queryRunner.query(`ALTER TABLE "delivery" DROP CONSTRAINT "FK_8b64ee4e6e615c2082862f9e09a"`);
        await queryRunner.query(`ALTER TABLE "delivery" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "car" DROP CONSTRAINT "FK_e823ac113ba2af8cbe72ddcbe84"`);
        await queryRunner.query(`ALTER TABLE "car" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "time_slot" DROP CONSTRAINT "FK_e87ae54beaee42b885813deb8e9"`);
        await queryRunner.query(`ALTER TABLE "time_slot" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "gas_cylinder" DROP CONSTRAINT "FK_990b829fdf06cb282d835a5d729"`);
        await queryRunner.query(`ALTER TABLE "gas_cylinder" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "order" DROP CONSTRAINT "FK_df56039592a4bbbd3fa4a19f141"`);
        await queryRunner.query(`DROP INDEX "public"."idx_order_dist_status_delivered"`);
        await queryRunner.query(`ALTER TABLE "order" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "rating" DROP CONSTRAINT "FK_b46b63fc1ddf2135e1ed37069a9"`);
        await queryRunner.query(`ALTER TABLE "rating" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "order_dispatch_offer" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "incident" DROP CONSTRAINT "FK_a2223c18baa97faf54118f95bd2"`);
        await queryRunner.query(`ALTER TABLE "incident" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "claims" DROP CONSTRAINT "FK_870bf1e0dc6005837ff0643b5fc"`);
        await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "distributor_id" SET NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_order_dist_status_delivered" ON "order" ("distributor_id", "status", "deliveredAt") `);
        await queryRunner.query(`ALTER TABLE "delivery" ADD CONSTRAINT "FK_8b64ee4e6e615c2082862f9e09a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "car" ADD CONSTRAINT "FK_e823ac113ba2af8cbe72ddcbe84" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "time_slot" ADD CONSTRAINT "FK_e87ae54beaee42b885813deb8e9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gas_cylinder" ADD CONSTRAINT "FK_990b829fdf06cb282d835a5d729" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order" ADD CONSTRAINT "FK_df56039592a4bbbd3fa4a19f141" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "rating" ADD CONSTRAINT "FK_b46b63fc1ddf2135e1ed37069a9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "incident" ADD CONSTRAINT "FK_a2223c18baa97faf54118f95bd2" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "claims" ADD CONSTRAINT "FK_870bf1e0dc6005837ff0643b5fc" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "claims" DROP CONSTRAINT "FK_870bf1e0dc6005837ff0643b5fc"`);
        await queryRunner.query(`ALTER TABLE "incident" DROP CONSTRAINT "FK_a2223c18baa97faf54118f95bd2"`);
        await queryRunner.query(`ALTER TABLE "rating" DROP CONSTRAINT "FK_b46b63fc1ddf2135e1ed37069a9"`);
        await queryRunner.query(`ALTER TABLE "order" DROP CONSTRAINT "FK_df56039592a4bbbd3fa4a19f141"`);
        await queryRunner.query(`ALTER TABLE "gas_cylinder" DROP CONSTRAINT "FK_990b829fdf06cb282d835a5d729"`);
        await queryRunner.query(`ALTER TABLE "time_slot" DROP CONSTRAINT "FK_e87ae54beaee42b885813deb8e9"`);
        await queryRunner.query(`ALTER TABLE "car" DROP CONSTRAINT "FK_e823ac113ba2af8cbe72ddcbe84"`);
        await queryRunner.query(`ALTER TABLE "delivery" DROP CONSTRAINT "FK_8b64ee4e6e615c2082862f9e09a"`);
        await queryRunner.query(`DROP INDEX "public"."idx_order_dist_status_delivered"`);
        await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "claims" ADD CONSTRAINT "FK_870bf1e0dc6005837ff0643b5fc" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "incident" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "incident" ADD CONSTRAINT "FK_a2223c18baa97faf54118f95bd2" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_dispatch_offer" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "rating" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "rating" ADD CONSTRAINT "FK_b46b63fc1ddf2135e1ed37069a9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_order_dist_status_delivered" ON "order" ("status", "deliveredAt", "distributor_id") `);
        await queryRunner.query(`ALTER TABLE "order" ADD CONSTRAINT "FK_df56039592a4bbbd3fa4a19f141" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gas_cylinder" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "gas_cylinder" ADD CONSTRAINT "FK_990b829fdf06cb282d835a5d729" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "time_slot" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "time_slot" ADD CONSTRAINT "FK_e87ae54beaee42b885813deb8e9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "car" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "car" ADD CONSTRAINT "FK_e823ac113ba2af8cbe72ddcbe84" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "delivery" ALTER COLUMN "distributor_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "delivery" ADD CONSTRAINT "FK_8b64ee4e6e615c2082862f9e09a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
