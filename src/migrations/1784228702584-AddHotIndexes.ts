import { MigrationInterface, QueryRunner } from "typeorm";

export class AddHotIndexes1784228702584 implements MigrationInterface {
    name = 'AddHotIndexes1784228702584'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_a3b8af1ce2f6e143d416d83080" ON "delivery" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_cd7812c96209c5bdd48a6b858b" ON "order" ("customer_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7a9573d6a1fb982772a9123320" ON "order" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_f437a76442f23c89ad7652b2a4" ON "order" ("deliveredAt") `);
        await queryRunner.query(`CREATE INDEX "idx_order_dist_status_delivered" ON "order" ("distributor_id", "status", "deliveredAt") `);
        await queryRunner.query(`CREATE INDEX "idx_order_status_delivery" ON "order" ("status", "delivery_id") `);
        await queryRunner.query(`CREATE INDEX "idx_offer_status_expires" ON "order_dispatch_offer" ("status", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "idx_offer_order_status" ON "order_dispatch_offer" ("order_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_offer_order_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_offer_status_expires"`);
        await queryRunner.query(`DROP INDEX "public"."idx_order_status_delivery"`);
        await queryRunner.query(`DROP INDEX "public"."idx_order_dist_status_delivered"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f437a76442f23c89ad7652b2a4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7a9573d6a1fb982772a9123320"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cd7812c96209c5bdd48a6b858b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a3b8af1ce2f6e143d416d83080"`);
    }

}
