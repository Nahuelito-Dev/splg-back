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

const FORMATEADORES_DE_HORA = new Map<string, Intl.DateTimeFormat>();

/** Crear un `Intl.DateTimeFormat` es caro: uno por zona, reusado (las métricas lo llaman miles de veces). */
function formateadorDeHora(zona: string): Intl.DateTimeFormat {
  let f = FORMATEADORES_DE_HORA.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    FORMATEADORES_DE_HORA.set(zona, f);
  }
  return f;
}

/** Día de la semana y minuto del día de `ahora` en la zona horaria dada. */
export function horaLocal(
  ahora: Date,
  zona: string,
): { weekday: number; minuto: number } {
  const partes = formateadorDeHora(zona).formatToParts(ahora);
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

const MINUTOS_DE_LA_SEMANA = 7 * 24 * 60;

/** Minuto de la semana (0 = domingo 00:00) de `ahora` en la zona dada. */
function minutoDeLaSemana(ahora: Date, zona: string): number {
  const { weekday, minuto } = horaLocal(ahora, zona);
  return weekday * 24 * 60 + minuto;
}

/**
 * Cuándo vuelve a abrir la atención, o `null` si está abierta ahora o si no
 * hay franjas (atiende siempre). Se busca la apertura más cercana hacia
 * adelante en la semana; si la zona tiene cambio de hora entre medio, se
 * corrige con la hora local del resultado.
 */
export function proximaApertura(
  franjas: readonly FranjaDeAtencion[],
  zona: string,
  ahora: Date,
): Date | null {
  if (franjas.length === 0 || estaAbierto(franjas, zona, ahora)) return null;
  const actual = minutoDeLaSemana(ahora, zona);
  let falta = Infinity;
  let destino = 0;
  for (const f of franjas) {
    const abre = f.weekday * 24 * 60 + minutos(f.opensAt);
    const d =
      (((abre - actual) % MINUTOS_DE_LA_SEMANA) + MINUTOS_DE_LA_SEMANA) %
      MINUTOS_DE_LA_SEMANA;
    // `d === 0` sería «abre en este minuto», pero entonces estaría abierta.
    const espera = d === 0 ? MINUTOS_DE_LA_SEMANA : d;
    if (espera < falta) {
      falta = espera;
      destino = abre;
    }
  }
  const inicioDelMinuto = Math.floor(ahora.getTime() / 60_000) * 60_000;
  const candidato = new Date(inicioDelMinuto + falta * 60_000);
  let corrimiento =
    (destino - minutoDeLaSemana(candidato, zona)) % MINUTOS_DE_LA_SEMANA;
  if (corrimiento > MINUTOS_DE_LA_SEMANA / 2)
    corrimiento -= MINUTOS_DE_LA_SEMANA;
  if (corrimiento < -MINUTOS_DE_LA_SEMANA / 2)
    corrimiento += MINUTOS_DE_LA_SEMANA;
  return new Date(candidato.getTime() + corrimiento * 60_000);
}
