import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeSinTransferencia,
  sentenciasParaQuitarSinTransferencia,
} from './sql/sin-transferencia';

/**
 * La transferencia deja de aceptarse como medio de pago: triggers que rechazan
 * los pedidos y las invitaciones de recompra NUEVOS con transferencia (ver
 * `sql/sin-transferencia.ts`). No toca ninguna fila: los pedidos históricos con
 * transferencia siguen como estaban y el valor `transfer` se queda en el enum.
 * No agrega tablas ni columnas, así que el mapa de auditoría no cambia (los
 * triggers de auditoría de `order` y `repurchase_invitation` siguen intactos).
 */
export class SinTransferencia1795000000159 implements MigrationInterface {
  name = 'SinTransferencia1795000000159';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of sentenciasDeSinTransferencia()) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of sentenciasParaQuitarSinTransferencia()) {
      await queryRunner.query(sql);
    }
  }
}
