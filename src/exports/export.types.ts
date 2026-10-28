import type { Type } from '@nestjs/common';

/** Formatos de salida del exporte. */
export enum ExportFormat {
  CSV = 'csv',
  XLSX = 'xlsx',
}

/** Valor de una celda ya calculado, listo para escribir. */
export type Celda = string | number | boolean | Date | null | undefined;

/**
 * Cómo se escribe y se formatea una columna.
 * - `texto`: texto libre. En CSV, si arranca con = + - @ se escapa.
 * - `codigo`: texto que parece número (CUIT, teléfono, acta): no pierde ceros.
 * - `entero`, `decimal`: números (coma decimal en CSV).
 * - `moneda`: pesos argentinos con dos decimales.
 * - `fecha`: día calendario (`YYYY-MM-DD` o un instante, en hora argentina).
 * - `fechaHora`: instante, en hora argentina.
 * - `booleano`: Sí / No.
 */
export type TipoDeColumna =
  | 'texto'
  | 'codigo'
  | 'entero'
  | 'decimal'
  | 'moneda'
  | 'fecha'
  | 'fechaHora'
  | 'booleano';

/** Columna de un exporte: encabezado en castellano y cómo sacar el valor de una fila. */
export interface Columna<F> {
  titulo: string;
  tipo: TipoDeColumna;
  /** Ancho aproximado en caracteres (Excel). */
  ancho?: number;
  valor: (fila: F) => Celda;
}

export interface Encabezado {
  titulo: string;
  tipo: TipoDeColumna;
  ancho: number;
}

/** Un lote de filas ya convertidas a celdas, más el total que cumple los filtros. */
export interface LoteDeFilas {
  filas: Celda[][];
  total: number;
}

/** Una consulta lista para leer por lotes: los filtros ya están validados. */
export interface ConsultaDeExporte {
  /** `false` si el listado de origen no pagina: una sola lectura trae todo. */
  paginada: boolean;
  leer: (desde: number, lote: number) => Promise<LoteDeFilas>;
}

/** Un recurso exportable. */
export interface FuenteDeExporte {
  recurso: string;
  descripcion: string;
  encabezados: Encabezado[];
  /** Valida los filtros contra el DTO de consulta del listado y arma la lectura. */
  preparar: (
    filtros: Record<string, unknown>,
    distribuidoraId: string,
  ) => Promise<ConsultaDeExporte>;
}

/** Posición de la página que se le pide al listado de origen. */
export interface Pagina {
  limit: number;
  offset: number;
  page: number;
}

/** Cómo se define un recurso: el DTO de filtros del listado, sus columnas y cómo leerlo. */
export interface DefinicionDeFuente<Q extends object, F> {
  recurso: string;
  descripcion: string;
  /** DTO de consulta del listado: define y valida los filtros aceptados. */
  query: Type<Q>;
  columnas: Columna<F>[];
  /** Pone la página en los filtros. Sin esto, el listado de origen no pagina. */
  paginar?: (query: Q, pagina: Pagina) => void;
  leer: (
    query: Q,
    distribuidoraId: string,
  ) => Promise<{ filas: readonly F[]; total: number }>;
}
