import { diaDeLaSemana } from '../../../common/utils/dias-argentina';

/**
 * Feriados nacionales de Argentina (con los trasladables ya movidos) y días no
 * laborables con fines turísticos. Lista cargada a mano para 2026 y 2027: hay
 * que revisarla contra el decreto de cada año y ampliarla antes de que termine
 * 2027. Los feriados provinciales y locales no están.
 */
export const FERIADOS_AR: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-03-23',
  '2026-03-24',
  '2026-04-02',
  '2026-04-03',
  '2026-05-01',
  '2026-05-25',
  '2026-06-15',
  '2026-06-20',
  '2026-07-09',
  '2026-07-10',
  '2026-08-17',
  '2026-10-12',
  '2026-11-23',
  '2026-12-07',
  '2026-12-08',
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-02-08',
  '2027-02-09',
  '2027-03-24',
  '2027-03-26',
  '2027-04-02',
  '2027-05-25',
  '2027-06-21',
  '2027-07-09',
  '2027-08-16',
  '2027-10-11',
  '2027-12-08',
]);

/** Lunes a sábado: el valor por omisión de `workshopDays` (bit n = día de la semana n, 0 = domingo). */
export const DIAS_DE_TALLER_POR_OMISION = 0b1111110;

export const esFeriado = (dia: string): boolean => FERIADOS_AR.has(dia);

/** Los días de la semana (0 = domingo … 6 = sábado) que activa la máscara. */
export const diasDeLaMascara = (mascara: number): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => (mascara & (1 << d)) !== 0);

/** El taller atiende ese día: es un día habilitado de la semana y no es feriado. */
export const esDiaDeTaller = (dia: string, mascara: number): boolean =>
  (mascara & (1 << diaDeLaSemana(dia))) !== 0 && !esFeriado(dia);
