/**
 * Evento (después del commit) de que hay hojas de ruta en curso que otros
 * módulos pueden aprovechar: al iniciarse una hoja (con su `batchId`) y en cada
 * pasada del seguimiento de hojas (sin hoja: todas las de hoy de la distribuidora,
 * o de todas si tampoco viene la distribuidora).
 */
export const EVENTO_HOJA_EN_CURSO = 'hoja-de-ruta.en-curso';

export interface HojaEnCurso {
  distributorId: string | null;
  batchId: string | null;
}
