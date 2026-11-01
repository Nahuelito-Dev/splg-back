import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los pagos que el ledger anterior guardó como `refunded` por un contracargo
 * (`metadata.gatewayStatus = 'charged_back'`: no tenía el estado propio) pasan a
 * `charged_back`. El trigger `payment_estado_no_retrocede` no deja pasar de `refunded` a
 * `charged_back` (con razón: son finales): se lo suspende sólo para esta corrección,
 * que toca únicamente esas filas.
 */
export class ContracargosComoContracargo1794700000014
  implements MigrationInterface
{
  name = 'ContracargosComoContracargo1794700000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment" DISABLE TRIGGER "TRG_payment_estado_no_retrocede"`,
    );
    await queryRunner.query(
      `UPDATE "payment" SET "status" = 'charged_back',
         "status_history" = "status_history" || jsonb_build_array(jsonb_build_object(
           'status', 'charged_back', 'statusDetail', "status_detail", 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'origin', 'consulta', 'applied', true))
       WHERE "status" = 'refunded' AND "metadata" ->> 'gatewayStatus' = 'charged_back'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ENABLE TRIGGER "TRG_payment_estado_no_retrocede"`,
    );
  }

  public async down(): Promise<void> {
    // No se vuelve a `refunded`: el estado correcto es `charged_back` y el esquema
    // anterior ya admite ese valor del enum.
  }
}
