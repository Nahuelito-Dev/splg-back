import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CHEQUEOS_DE_DATOS,
  sentenciasDeReglasDeDatos,
  sentenciasParaQuitarReglasDeDatos,
} from './sql/reglas-de-datos';

/**
 * Reglas que el back tenía (o tiene desde esta tanda) y que la base también
 * exige: largo máximo de los textos de reclamos, incidencias, calificaciones y
 * nota de impago; pago de una multa contra su importe; fecha esperada de una
 * orden de compra; y, con triggers, cobro de cuenta corriente contra la deuda,
 * fabricación de envase no futura, rendición sin fecha futura y odómetros
 * monótonos (ver `sql/reglas-de-datos.ts`).
 *
 * Antes de cada CHECK cuenta las filas que hoy lo violarían; si hay alguna,
 * aborta con la consulta para verlas (no recorta textos ni toca importes por su
 * cuenta). Se crean `NOT VALID` y se validan aparte para no bloquear la tabla
 * más de lo necesario.
 */
export class ReglasDelBackEnLaBase1792701500000 implements MigrationInterface {
  name = 'ReglasDelBackEnLaBase1792701500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const violadas: string[] = [];
    for (const c of CHEQUEOS_DE_DATOS) {
      const [{ total }] = (await queryRunner.query(
        `SELECT count(*)::int AS total FROM "${c.tabla}" WHERE NOT (${c.expresion})`,
      )) as Array<{ total: number }>;
      if (total > 0) {
        violadas.push(
          `${c.nombre}: ${total} fila(s) de ${c.tabla} (SELECT * FROM "${c.tabla}" WHERE NOT (${c.expresion}))`,
        );
      }
    }
    if (violadas.length > 0) {
      throw new Error(
        `No se pueden crear las reglas de datos: ${violadas.join('; ')}. Corregí esas filas y reintentá.`,
      );
    }
    for (const c of CHEQUEOS_DE_DATOS) {
      await queryRunner.query(
        `ALTER TABLE "${c.tabla}" ADD CONSTRAINT "${c.nombre}" CHECK (${c.expresion}) NOT VALID`,
      );
      await queryRunner.query(
        `ALTER TABLE "${c.tabla}" VALIDATE CONSTRAINT "${c.nombre}"`,
      );
    }
    for (const sql of sentenciasDeReglasDeDatos()) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of sentenciasParaQuitarReglasDeDatos()) {
      await queryRunner.query(sql);
    }
    for (const c of [...CHEQUEOS_DE_DATOS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${c.tabla}" DROP CONSTRAINT "${c.nombre}"`,
      );
    }
  }
}
