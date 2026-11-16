/**
 * Parámetros de la compra express de una distribuidora (CU-148, CU-149 y
 * CU-172): se guardan en `module_config` (proceso `express_dispatch`). Sin
 * configuración la modalidad express está apagada: requiere que la distribuidora
 * defina su recargo y su horario.
 */
export interface ExpressSettings {
  /** La distribuidora ofrece la modalidad express. */
  enabled: boolean;
  /** Recargo express fijo, en pesos (se guarda en el pedido). */
  surchargeAmount: number;
  /** Radio máximo, en km, en que se busca un chofer en moto: no se amplía. */
  maxRadiusKm: number;
  /** Ventana de aceptación de cada oferta express, en segundos (más corta que la del despacho normal). */
  offerTtlSeconds: number;
  /** Inicio del horario de servicio express, `HH:mm` hora argentina. */
  serviceFrom: string;
  /** Fin (exclusivo) del horario de servicio express, `HH:mm` hora argentina. */
  serviceTo: string;
  /** Tiempo estimado de una entrega express, en minutos. */
  estimatedMinutes: number;
  /** Tiempo estimado del reparto común, en minutos (para mostrar las dos modalidades). */
  standardEstimatedMinutes: number;
}

export const EXPRESS_RADIUS_MIN_KM = 1;
export const EXPRESS_RADIUS_MAX_KM = 50;
export const EXPRESS_OFFER_TTL_MIN_SECONDS = 10;
export const EXPRESS_OFFER_TTL_MAX_SECONDS = 120;
export const EXPRESS_SURCHARGE_MAX = 1_000_000;
export const EXPRESS_ESTIMATED_MIN_MINUTES = 5;
export const EXPRESS_ESTIMATED_MAX_MINUTES = 240;
export const STANDARD_ESTIMATED_MIN_MINUTES = 30;
export const STANDARD_ESTIMATED_MAX_MINUTES = 1440;
export const HORA_FORMATO = /^([01]\d|2[0-3]):[0-5]\d$/;

export function expressSettingsPorDefecto(): ExpressSettings {
  return {
    enabled: false,
    surchargeAmount: 0,
    maxRadiusKm: 5,
    offerTtlSeconds: 20,
    serviceFrom: '08:00',
    serviceTo: '20:00',
    estimatedMinutes: 45,
    standardEstimatedMinutes: 180,
  };
}

function esNumero(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor);
}

function enRango(valor: unknown, min: number, max: number): valor is number {
  return esNumero(valor) && valor >= min && valor <= max;
}

function esHora(valor: unknown): valor is string {
  return typeof valor === 'string' && HORA_FORMATO.test(valor);
}

/** Minutos desde las 00:00 de un `HH:mm`. */
export function minutosDeHora(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Los parámetros guardados, leídos con defensa: el JSON de `module_config` no se
 * valida solo, así que un valor ausente o fuera de rango cae al de omisión en
 * vez de romper la compra.
 */
export function expressSettingsDesde(
  params: Record<string, unknown> | null,
): ExpressSettings {
  const base = expressSettingsPorDefecto();
  if (!params) return base;

  const desde = esHora(params.serviceFrom)
    ? params.serviceFrom
    : base.serviceFrom;
  const hasta = esHora(params.serviceTo) ? params.serviceTo : base.serviceTo;
  const horarioValido = minutosDeHora(desde) < minutosDeHora(hasta);

  return {
    enabled: params.enabled === true,
    surchargeAmount: enRango(params.surchargeAmount, 0, EXPRESS_SURCHARGE_MAX)
      ? params.surchargeAmount
      : base.surchargeAmount,
    maxRadiusKm: enRango(
      params.maxRadiusKm,
      EXPRESS_RADIUS_MIN_KM,
      EXPRESS_RADIUS_MAX_KM,
    )
      ? params.maxRadiusKm
      : base.maxRadiusKm,
    offerTtlSeconds: enRango(
      params.offerTtlSeconds,
      EXPRESS_OFFER_TTL_MIN_SECONDS,
      EXPRESS_OFFER_TTL_MAX_SECONDS,
    )
      ? params.offerTtlSeconds
      : base.offerTtlSeconds,
    serviceFrom: horarioValido ? desde : base.serviceFrom,
    serviceTo: horarioValido ? hasta : base.serviceTo,
    estimatedMinutes: enRango(
      params.estimatedMinutes,
      EXPRESS_ESTIMATED_MIN_MINUTES,
      EXPRESS_ESTIMATED_MAX_MINUTES,
    )
      ? params.estimatedMinutes
      : base.estimatedMinutes,
    standardEstimatedMinutes: enRango(
      params.standardEstimatedMinutes,
      STANDARD_ESTIMATED_MIN_MINUTES,
      STANDARD_ESTIMATED_MAX_MINUTES,
    )
      ? params.standardEstimatedMinutes
      : base.standardEstimatedMinutes,
  };
}

export function sonLosDeOmisionExpress(settings: ExpressSettings): boolean {
  const base = expressSettingsPorDefecto();
  return (Object.keys(base) as Array<keyof ExpressSettings>).every(
    (k) => settings[k] === base[k],
  );
}

/** Minutos desde las 00:00 en hora argentina (UTC-3 todo el año) de un instante. */
export function minutoDelDiaArgentino(instante: Date): number {
  const utc = instante.getUTCHours() * 60 + instante.getUTCMinutes();
  return (utc - 180 + 1440) % 1440;
}

/** ¿El instante cae dentro del horario de servicio express? */
export function dentroDelHorarioExpress(
  settings: Pick<ExpressSettings, 'serviceFrom' | 'serviceTo'>,
  instante: Date,
): boolean {
  const m = minutoDelDiaArgentino(instante);
  return (
    m >= minutosDeHora(settings.serviceFrom) &&
    m < minutosDeHora(settings.serviceTo)
  );
}
