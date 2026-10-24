import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MAQUINAS_DE_ESTADO,
  quitarTriggerDeTransicion,
  sentenciasDeTransiciones,
} from './sql/transiciones-de-estado';

/**
 * Triggers de transición de estado (tanda V2 de validaciones): pedido, envase,
 * rendición, liquidación, orden de compra, carga del camión, reclamo, cuenta
 * corriente y oferta de despacho. Calcan las máquinas de estado del dominio (ver
 * `sql/transiciones-de-estado.ts`). No toca datos: sólo frena UPDATE inválidos.
 */
export class TransicionesDeEstado1792701200000 implements MigrationInterface {
  name = 'TransicionesDeEstado1792701200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of sentenciasDeTransiciones()) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const m of MAQUINAS_DE_ESTADO) {
      for (const sql of quitarTriggerDeTransicion(m)) {
        await queryRunner.query(sql);
      }
    }
  }
}
