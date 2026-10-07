import { MigrationInterface, QueryRunner } from 'typeorm';

export class OfertaDeDespachoReemplazada1791100500000
  implements MigrationInterface
{
  name = 'OfertaDeDespachoReemplazada1791100500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."order_dispatch_offer_status_enum" ADD VALUE IF NOT EXISTS 'superseded'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las ofertas retiradas por una edición se vuelven "expired" (el valor más
    // parecido que tiene el enum viejo).
    await queryRunner.query(
      `ALTER TYPE "public"."order_dispatch_offer_status_enum" RENAME TO "order_dispatch_offer_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_dispatch_offer_status_enum" AS ENUM('offered', 'accepted', 'rejected', 'expired')`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ALTER COLUMN "status" TYPE "public"."order_dispatch_offer_status_enum" USING (CASE WHEN "status"::text = 'superseded' THEN 'expired' ELSE "status"::text END)::"public"."order_dispatch_offer_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ALTER COLUMN "status" SET DEFAULT 'offered'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."order_dispatch_offer_status_enum_old"`,
    );
  }
}
