import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F15, comprobante de la multa con dueño propio, segunda parte: los adjuntos que
 * hoy son comprobante pasan de `traffic_fine` (la copia del acta) a
 * `traffic_fine_payment`: los que apunta `receipt_attachment_id` y los subidos
 * con la etiqueta «Comprobante de pago de la multa» que no se usaron (intentos
 * de pago que no se guardaron). Ninguna fila se borra.
 */
export class ComprobanteDeMultaDuenoPropio1793800000003
  implements MigrationInterface
{
  name = 'ComprobanteDeMultaDuenoPropio1793800000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "attachment" SET "owner_type" = 'traffic_fine_payment'
       WHERE "owner_type" = 'traffic_fine'
         AND ("label" = 'Comprobante de pago de la multa'
              OR "attachment_id" IN (SELECT "receipt_attachment_id" FROM "traffic_fine" WHERE "receipt_attachment_id" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "attachment" SET "owner_type" = 'traffic_fine' WHERE "owner_type" = 'traffic_fine_payment'`,
    );
  }
}
