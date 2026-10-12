import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/** Tipos de documento numerados. Cada módulo agrega el suyo al usarlo. */
export enum DocType {
  PURCHASE_ORDER = 'purchase_order',
  PURCHASE_RECEIPT = 'purchase_receipt',
  INTERNAL_DELIVERY_NOTE = 'internal_delivery_note',
  TRUCK_LOAD = 'truck_load',
  DRIVER_SETTLEMENT = 'driver_settlement',
  STOCK_ADJUSTMENT = 'stock_adjustment',
  EMPLOYEE_FILE = 'employee_file',
}

/** Mismo largo que la columna `doc_type`. */
const FORMATO_DOC_TYPE = /^[a-z][a-z0-9_]{0,39}$/;

@Injectable()
export class DocumentSequenceService {
  /**
   * Siguiente número correlativo del documento. Tiene que correr dentro de la
   * transacción del documento (`manager` es el de esa transacción): la fila de
   * la secuencia queda bloqueada hasta el commit, así que dos transacciones
   * nunca reciben el mismo número y, si la del documento se revierte, el
   * número vuelve a quedar libre (sin huecos salvo rollback).
   *
   * Es un único `INSERT … ON CONFLICT DO UPDATE`: toma el lock de fila igual
   * que un `SELECT … FOR UPDATE` y además resuelve la carrera del primer
   * número, cuando la fila todavía no existe.
   *
   * Lanza un error de programación si no hay transacción activa (sin ella el
   * lock se suelta al terminar la sentencia y no hay rollback conjunto) o si
   * `docType` no tiene el formato esperado (minúsculas, dígitos y `_`, hasta 40).
   *
   * Orden de locks: es la última que se toma dentro de la transacción del
   * documento.
   */
  async siguienteNumero(
    manager: EntityManager,
    distributorId: string,
    docType: DocType | string,
  ): Promise<number> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error(
        'siguienteNumero tiene que llamarse dentro de la transacción del documento',
      );
    }
    if (!FORMATO_DOC_TYPE.test(docType)) {
      throw new Error(
        `Tipo de documento inválido para la numeración: "${docType}"`,
      );
    }
    const filas: { last_number: number }[] = await manager.query(
      `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number")
       VALUES ($1, $2, 1)
       ON CONFLICT ("distributor_id", "doc_type")
       DO UPDATE SET "last_number" = "document_sequence"."last_number" + 1
       RETURNING "last_number"`,
      [distributorId, docType],
    );
    return filas[0].last_number;
  }
}
