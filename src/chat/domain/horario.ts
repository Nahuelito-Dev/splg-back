/** Una franja de atención de un día de la semana (0 = domingo), en hora local. */
export interface FranjaDeAtencion {
  weekday: number;
  /** `HH:MM` */
  opensAt: string;
  /** `HH:MM`, posterior a `opensAt` */
  closesAt: string;
}

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function esHora(valor: string): boolean {
  return HORA.test(valor);
}

function minutos(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/** Las franjas son válidas: hora bien escrita, apertura antes del cierre y sin solaparse en el mismo día. */
export function franjasValidas(franjas: readonly FranjaDeAtencion[]): boolean {
  for (const f of franjas) {
    if (!Number.isInteger(f.weekday) || f.weekday < 0 || f.weekday > 6) {
      return false;
    }
    if (!esHora(f.opensAt) || !esHora(f.closesAt)) return false;
    if (minutos(f.opensAt) >= minutos(f.closesAt)) return false;
  }
  for (const a of franjas) {
    for (const b of franjas) {
      if (a === b || a.weekday !== b.weekday) continue;
      const seSolapan =
        minutos(a.opensAt) < minutos(b.closesAt) &&
        minutos(b.opensAt) < minutos(a.closesAt);
      if (seSolapan) return false;
    }
  }
  return true;
}

const DIAS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Día de la semana y minuto del día de `ahora` en la zona horaria dada. */
export function horaLocal(
  ahora: Date,
  zona: string,
): { weekday: number; minuto: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ahora);
  const valor = (tipo: string) =>
    partes.find((p) => p.type === tipo)?.value ?? '';
  return {
    weekday: DIAS[valor('weekday')] ?? 0,
    minuto: Number(valor('hour')) * 60 + Number(valor('minute')),
  };
}

/**
 * Si la plataforma atiende en este momento. Sin franjas cargadas atiende
 * siempre (no se responde automáticamente).
 */
export function estaAbierto(
  franjas: readonly FranjaDeAtencion[],
  zona: string,
  ahora: Date,
): boolean {
  if (franjas.length === 0) return true;
  const { weekday, minuto } = horaLocal(ahora, zona);
  return franjas.some(
    (f) =>
      f.weekday === weekday &&
      minutos(f.opensAt) <= minuto &&
      minuto < minutos(f.closesAt),
  );
}
