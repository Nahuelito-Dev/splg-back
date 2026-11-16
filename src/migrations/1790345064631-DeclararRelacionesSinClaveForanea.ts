import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeclararRelacionesSinClaveForanea1790345064631
  implements MigrationInterface
{
  name = 'DeclararRelacionesSinClaveForanea1790345064631';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rating" ADD CONSTRAINT "FK_6f590ebbc097c4ed21d5d3e11ed" FOREIGN KEY ("to_user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "FK_f5221735ace059250daac9d9803" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "FK_0cdad15fa39dd1ebace139096fe" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD CONSTRAINT "FK_830f3888d1424414675f1c184d9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD CONSTRAINT "FK_0f0f1167f4d0249c579b32b10ce" FOREIGN KEY ("driver_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ADD CONSTRAINT "FK_583453357cb3e8da99d4bc5a28c" FOREIGN KEY ("reported_by") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD CONSTRAINT "FK_f5b98a008ff9f846381bb5494d5" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD CONSTRAINT "FK_623bf3b34c3d9586cf2ae461573" FOREIGN KEY ("current_customer_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD CONSTRAINT "FK_903b537f13281f56613047bcdce" FOREIGN KEY ("current_order_id") REFERENCES "order"("order_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" ADD CONSTRAINT "FK_1c48ac355fa0315ba792b680456" FOREIGN KEY ("cylinder_id") REFERENCES "cylinder"("cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" ADD CONSTRAINT "FK_968ad11170db2741bb5c0c47bb3" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" ADD CONSTRAINT "FK_2130833c25a6c8ef1a1bf119ed0" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" ADD CONSTRAINT "FK_e69720a167d0129aa6dbe492cb2" FOREIGN KEY ("actor_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" DROP CONSTRAINT "FK_e69720a167d0129aa6dbe492cb2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" DROP CONSTRAINT "FK_2130833c25a6c8ef1a1bf119ed0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" DROP CONSTRAINT "FK_968ad11170db2741bb5c0c47bb3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_movement" DROP CONSTRAINT "FK_1c48ac355fa0315ba792b680456"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" DROP CONSTRAINT "FK_903b537f13281f56613047bcdce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" DROP CONSTRAINT "FK_623bf3b34c3d9586cf2ae461573"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" DROP CONSTRAINT "FK_f5b98a008ff9f846381bb5494d5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" DROP CONSTRAINT "FK_583453357cb3e8da99d4bc5a28c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP CONSTRAINT "FK_0f0f1167f4d0249c579b32b10ce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP CONSTRAINT "FK_830f3888d1424414675f1c184d9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "FK_0cdad15fa39dd1ebace139096fe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "FK_f5221735ace059250daac9d9803"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" DROP CONSTRAINT "FK_6f590ebbc097c4ed21d5d3e11ed"`,
    );
  }
}
