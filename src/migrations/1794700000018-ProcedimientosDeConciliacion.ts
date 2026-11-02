import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  BORRAR_PROCEDIMIENTOS_DE_CONCILIACION,
  CREAR_PROCEDIMIENTOS_DE_CONCILIACION,
} from './sql/procedimientos-de-conciliacion';

/**
 * Procedimientos almacenados de las conciliaciones nocturnas
 * (`conciliar_stock_del_dia` y `verificar_saldos_de_caja`, se llaman con
 * `CALL`). Ninguno corrige datos. El SQL y las reglas de uso están en
 * `sql/procedimientos-de-conciliacion.ts`.
 */
export class ProcedimientosDeConciliacion1794700000018
  implements MigrationInterface
{
  name = 'ProcedimientosDeConciliacion1794700000018';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of CREAR_PROCEDIMIENTOS_DE_CONCILIACION) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of BORRAR_PROCEDIMIENTOS_DE_CONCILIACION) {
      await queryRunner.query(sql);
    }
  }
}
