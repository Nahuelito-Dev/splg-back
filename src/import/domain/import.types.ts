import { EntityManager } from 'typeorm';

/** Una columna de la plantilla: el encabezado en castellano y un valor de ejemplo. */
export interface ColumnaDeImportacion {
  /** Nombre de la propiedad del DTO al que va (o clave interna). */
  key: string;
  header: string;
  ejemplo: string;
  obligatoria: boolean;
}

/** Una fila del archivo tal como vino: texto por columna. `fila` es la del Excel (el encabezado es la 1). */
export interface FilaCruda {
  fila: number;
  celdas: Record<string, string>;
}

export interface ErrorDeFila {
  fila: number;
  columna: string;
  mensaje: string;
}

/** Una fila ya validada y normalizada; sólo valores serializables a JSON. */
export interface FilaNormalizada {
  fila: number;
  datos: Record<string, unknown>;
}

export interface ResultadoDeValidacion {
  errores: ErrorDeFila[];
  filas: FilaNormalizada[];
}

export interface ContextoDeAplicacion {
  distributorId: string;
  actorUserId: string;
  importId: string;
  fileName: string;
}

/** Cuánto se aplicó, por concepto (p. ej. `{ creadas: 12 }`). */
export type ResumenDeImportacion = Record<string, number>;

/** Lo que sabe hacer cada recurso: su plantilla, validar sus filas y aplicarlas. */
export interface ImportHandler {
  readonly recurso: string;
  readonly columnas: ColumnaDeImportacion[];
  validar(
    filas: FilaCruda[],
    distributorId: string,
  ): Promise<ResultadoDeValidacion>;
  /** Corre dentro de la transacción de la confirmación; si lanza, se revierte todo. */
  aplicar(
    manager: EntityManager,
    filas: FilaNormalizada[],
    ctx: ContextoDeAplicacion,
  ): Promise<ResumenDeImportacion>;
}

export const MAX_ARCHIVO_BYTES = 5 * 1024 * 1024;
export const MAX_FILAS = 5000;
export const FILAS_DE_VISTA_PREVIA = 20;
export const VIGENCIA_HORAS = 24;
