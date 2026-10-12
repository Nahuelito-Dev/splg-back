/**
 * Topes de los DTO para que ningún total pueda desbordar `numeric(12,2)`
 * (máximo 9.999.999.999,99): 20 renglones x 5.000 unidades x $90.000 =
 * $9.000.000.000.
 */
export const MAX_RENGLONES = 20;
export const MAX_UNIDADES = 5000;
export const MAX_COSTO = 90000;
