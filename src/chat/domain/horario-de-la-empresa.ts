import {
  estaAbierto,
  type FranjaDeAtencion,
  horaLocal,
  proximaApertura,
} from './horario';

/** Un día sin atención (feriado, inventario…), en la fecha local de la empresa. */
export interface DiaSinAtencion {
  /** `YYYY-MM-DD` */
  date: string;
  reason: string;
}

/**
 * El horario de atención del chat de una empresa (diseño §8.4): franjas por día
 * de la semana, días sin atención y la zona horaria. Sin franjas, atiende todo
 * el día (salvo los días sin atención).
 */
export interface HorarioDeLaEmpresa {
  franjas: readonly FranjaDeAtencion[];
  feriados: readonly DiaSinAtencion[];
  zona: string;
}

const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `YYYY-MM-DD` válida (también el día del mes: 2026-02-30 no). */
export function esFecha(valor: string): boolean {
  if (!FECHA.test(valor)) return false;
  const [a, m, d] = valor.split('-').map(Number);
  const fecha = new Date(Date.UTC(a, m - 1, d));
  return fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d;
}

/** Los días sin atención son válidos: fecha bien escrita, motivo de 2 a 120 caracteres y sin repetir el día. */
export function feriadosValidos(feriados: readonly DiaSinAtencion[]): boolean {
  const vistos = new Set<string>();
  for (const f of feriados) {
    if (!esFecha(f.date) || vistos.has(f.date)) return false;
    const motivo = f.reason.trim();
    if (motivo.length < 2 || motivo.length > 120) return false;
    vistos.add(f.date);
  }
  return true;
}

/** Uno por zona, reusado (crear un `Intl.DateTimeFormat` es caro). */
const FORMATEADORES_DE_FECHA = new Map<string, Intl.DateTimeFormat>();

/** La fecha local (`YYYY-MM-DD`) de `ahora` en la zona dada. */
export function fechaLocal(ahora: Date, zona: string): string {
  let f = FORMATEADORES_DE_FECHA.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    FORMATEADORES_DE_FECHA.set(zona, f);
  }
  return f.format(ahora);
}

function esDiaSinAtencion(h: HorarioDeLaEmpresa, ahora: Date): boolean {
  if (h.feriados.length === 0) return false;
  const hoy = fechaLocal(ahora, h.zona);
  return h.feriados.some((f) => f.date === hoy);
}

const MINUTO = 60_000;
const DIA_EN_MINUTOS = 24 * 60;

/** El comienzo del minuto. */
function alMinuto(t: Date): Date {
  return new Date(Math.floor(t.getTime() / MINUTO) * MINUTO);
}

/** La medianoche local siguiente a `t`. */
function inicioDelDiaSiguiente(t: Date, zona: string): Date {
  const { minuto } = horaLocal(t, zona);
  return new Date(alMinuto(t).getTime() + (DIA_EN_MINUTOS - minuto) * MINUTO);
}

/** Si la empresa atiende el chat en este momento. */
export function atiendeLaEmpresa(h: HorarioDeLaEmpresa, ahora: Date): boolean {
  if (esDiaSinAtencion(h, ahora)) return false;
  return estaAbierto(h.franjas, h.zona, ahora);
}

/** Cuántas vueltas como mucho buscando la próxima apertura (un año de feriados seguidos no pasa). */
const VUELTAS = 400;

/**
 * Cuándo vuelve a atender, o `null` si atiende ahora. Saltea los días sin
 * atención: si la próxima franja cae en un feriado, busca la siguiente.
 */
export function proximaAtencion(
  h: HorarioDeLaEmpresa,
  ahora: Date,
): Date | null {
  if (atiendeLaEmpresa(h, ahora)) return null;
  let t = ahora;
  for (let i = 0; i < VUELTAS; i++) {
    if (esDiaSinAtencion(h, t)) {
      t = inicioDelDiaSiguiente(t, h.zona);
      if (atiendeLaEmpresa(h, t)) return t;
      continue;
    }
    if (atiendeLaEmpresa(h, t)) return t;
    const siguiente = proximaApertura(h.franjas, h.zona, t);
    if (!siguiente) return null;
    t = siguiente;
    if (atiendeLaEmpresa(h, t)) return t;
  }
  return null;
}

function minutosDe(hora: string): number {
  const [hh, mm] = hora.split(':').map(Number);
  return hh * 60 + mm;
}

/** Días que recorre como mucho (diez años: ninguna espera real llega). */
const DIAS_MAXIMOS = 3660;

/**
 * Minutos de atención entre dos momentos (diseño §8.4: el tiempo de primera
 * respuesta se cuenta en horario hábil, no en reloj corrido). Lo que cae fuera
 * de las franjas o en un día sin atención no suma.
 *
 * Recorre día por día (local): en cada uno suma lo que las franjas de ese día
 * de la semana se superponen con `[desde, hasta)`; sin franjas, el día entero.
 * Con `tope`, deja de contar apenas lo supera (devuelve algo mayor que `tope`):
 * para saber si una espera pasó el objetivo no hace falta medirla entera.
 */
export function minutosHabiles(
  h: HorarioDeLaEmpresa,
  desde: Date,
  hasta: Date,
  tope?: number,
): number {
  const inicio = desde.getTime();
  const final = hasta.getTime();
  if (final <= inicio) return 0;
  const franjasPorDia = new Map<number, Array<[number, number]>>();
  for (const f of h.franjas) {
    const del = franjasPorDia.get(f.weekday) ?? [];
    del.push([minutosDe(f.opensAt), minutosDe(f.closesAt)]);
    franjasPorDia.set(f.weekday, del);
  }
  const feriados = new Set(h.feriados.map((f) => f.date));
  const topeMs = tope === undefined ? Infinity : tope * MINUTO;
  let t = desde;
  let total = 0;
  // Lo ya contado: en el día del cambio de hora el siguiente puede arrancar antes.
  let contadoHasta = inicio;
  for (let i = 0; i < DIAS_MAXIMOS && t.getTime() < final; i++) {
    const { weekday, minuto } = horaLocal(t, h.zona);
    const medianoche = alMinuto(t).getTime() - minuto * MINUTO;
    const siguiente = medianoche + DIA_EN_MINUTOS * MINUTO;
    if (feriados.size === 0 || !feriados.has(fechaLocal(t, h.zona))) {
      const franjas =
        h.franjas.length === 0
          ? [[0, DIA_EN_MINUTOS] as [number, number]]
          : (franjasPorDia.get(weekday) ?? []);
      for (const [abre, cierra] of franjas) {
        const a = Math.max(medianoche + abre * MINUTO, contadoHasta);
        const b = Math.min(medianoche + cierra * MINUTO, final);
        if (b > a) total += b - a;
      }
      if (total > topeMs) break;
    }
    contadoHasta = Math.max(contadoHasta, siguiente);
    t = new Date(siguiente);
  }
  return Math.round(total / MINUTO);
}

const DIAS_DE_LA_SEMANA = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/**
 * La próxima apertura en castellano, para `{{horario.proximo}}`: «hoy a las
 * 14:00», «mañana a las 08:00» o «el lunes 17/11 a las 08:00».
 */
export function textoDeLaProximaAtencion(
  abre: Date,
  zona: string,
  ahora: Date,
): string {
  const hora = new Intl.DateTimeFormat('es-AR', {
    timeZone: zona,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(abre);
  const dia = fechaLocal(abre, zona);
  if (dia === fechaLocal(ahora, zona)) return `hoy a las ${hora}`;
  if (dia === fechaLocal(new Date(ahora.getTime() + 864e5), zona)) {
    return `mañana a las ${hora}`;
  }
  const [, mes, numero] = dia.split('-');
  const { weekday } = horaLocal(abre, zona);
  return `el ${DIAS_DE_LA_SEMANA[weekday]} ${numero}/${mes} a las ${hora}`;
}
