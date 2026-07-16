import { ValueTransformer } from 'typeorm';

/**
 * Transformer para columnas `decimal`/`numeric` de TypeORM. Postgres las
 * devuelve como STRING por precisión; sin esto, una columna tipada `number`
 * llega como string en runtime y `a + b` concatena en vez de sumar (bug de
 * plata real en los reportes). Este transformer las hidrata a `number` al leer
 * y las deja pasar tal cual al escribir.
 *
 * Nota: para montos con muchos decimales o aritmética sensible conviene
 * `decimal.js` (como en payments/pricing); para columnas de 2 decimales
 * (precios, totales, seña) `Number` es suficiente y saca el bug de raíz.
 */
export class ColumnNumericTransformer implements ValueTransformer {
  to(value: number | null | undefined): number | null | undefined {
    return value;
  }

  from(value: string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    return Number(value);
  }
}

/** Instancia reusable (los transformers no tienen estado). */
export const columnNumericTransformer = new ColumnNumericTransformer();
