/**
 * Días calendario de la operación: la distribuidora trabaja en
 * America/Argentina/Buenos_Aires (UTC-3, sin horario de verano). El vencimiento
 * de un envase es un día de calendario de esa zona: vale durante todo el día.
 */
const OFFSET_AR_MS = 3 * 60 * 60 * 1000;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

const FORMATO_DIA = /^(\d{4}-\d{2}-\d{2})/;

/** El día `YYYY-MM-DD` de un texto ISO (la parte de fecha, sin correr por zona). */
export function diaDeTexto(texto: string): string {
  const match = FORMATO_DIA.exec(texto);
  if (!match) throw new Error(`Fecha inválida: ${texto}`);
  return match[1];
}

/** El día calendario argentino en el que cae un instante. */
export function diaArgentino(instante: Date): string {
  return new Date(instante.getTime() - OFFSET_AR_MS).toISOString().slice(0, 10);
}

/** 00:00:00.000 hora argentina del día. */
export function inicioDelDia(dia: string): Date {
  return new Date(Date.parse(`${dia}T00:00:00.000Z`) + OFFSET_AR_MS);
}

/** 23:59:59.999 hora argentina del día: hasta ahí es vigente el envase que vence ese día. */
export function finDelDia(dia: string): Date {
  return new Date(inicioDelDia(dia).getTime() + MS_POR_DIA - 1);
}

/** Cuántos días calendario hay de `desde` a `hasta` (negativo si `hasta` es anterior). */
export function diasEntre(desde: Date, hasta: Date): number {
  const dias =
    (Date.parse(diaArgentino(hasta)) - Date.parse(diaArgentino(desde))) /
    MS_POR_DIA;
  return dias + 0;
}
