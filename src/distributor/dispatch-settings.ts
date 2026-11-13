/**
 * Parámetros del despacho de una distribuidora (M1, CU-171) y sus valores por
 * omisión: son los que regían cuando eran constantes del programa, así que una
 * distribuidora que no configura nada se comporta igual.
 */
export interface DispatchSettings {
  /** Pasos de radio (km) con que se amplía la búsqueda de choferes. */
  radiusStepsKm: number[];
  /** Ventana de aceptación de cada oferta, en segundos. */
  offerTtlSeconds: number;
  /**
   * Radio (m) al punto de entrega dentro del cual un chofer con un solo pedido
   * en camino cuenta como «por terminar» y puede recibir otra oferta. 0 = apagado.
   */
  finishingRadiusMeters: number;
  /**
   * Minutos que un pedido pendiente puede esperar chofer desde que se puede
   * ofrecer (o desde que arranca su agenda) antes de que el sistema lo cancele.
   */
  noDriverExpiryMinutes: number;
}

export const DEFAULT_RADIUS_STEPS_KM: readonly number[] = [5, 10, 15, 20];
export const DEFAULT_OFFER_TTL_SECONDS = 30;
export const DEFAULT_FINISHING_RADIUS_METERS = 300;
export const DEFAULT_NO_DRIVER_EXPIRY_MINUTES = 120;

export const DISPATCH_RADIUS_MIN_STEPS = 1;
export const DISPATCH_RADIUS_MAX_STEPS = 8;
export const DISPATCH_RADIUS_MIN_KM = 1;
export const DISPATCH_RADIUS_MAX_KM = 100;
export const DISPATCH_OFFER_TTL_MIN_SECONDS = 10;
export const DISPATCH_OFFER_TTL_MAX_SECONDS = 300;
export const DISPATCH_FINISHING_RADIUS_MIN_METERS = 0;
export const DISPATCH_FINISHING_RADIUS_MAX_METERS = 5000;
export const DISPATCH_NO_DRIVER_EXPIRY_MIN_MINUTES = 1;
export const DISPATCH_NO_DRIVER_EXPIRY_MAX_MINUTES = 1440;

export function dispatchSettingsPorDefecto(): DispatchSettings {
  return {
    radiusStepsKm: [...DEFAULT_RADIUS_STEPS_KM],
    offerTtlSeconds: DEFAULT_OFFER_TTL_SECONDS,
    finishingRadiusMeters: DEFAULT_FINISHING_RADIUS_METERS,
    noDriverExpiryMinutes: DEFAULT_NO_DRIVER_EXPIRY_MINUTES,
  };
}

function esNumero(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor);
}

/**
 * Los parámetros guardados, leídos con defensa: el JSON de `module_config` no se
 * valida solo, así que un valor ausente o fuera de rango cae al de omisión en
 * vez de romper el despacho.
 */
export function dispatchSettingsDesde(
  params: Record<string, unknown> | null,
): DispatchSettings {
  const porDefecto = dispatchSettingsPorDefecto();
  if (!params) return porDefecto;

  const pasos = params.radiusStepsKm;
  const pasosValidos =
    Array.isArray(pasos) &&
    pasos.length >= DISPATCH_RADIUS_MIN_STEPS &&
    pasos.length <= DISPATCH_RADIUS_MAX_STEPS &&
    pasos.every(
      (p, i) =>
        esNumero(p) &&
        p >= DISPATCH_RADIUS_MIN_KM &&
        p <= DISPATCH_RADIUS_MAX_KM &&
        (i === 0 || p > (pasos[i - 1] as number)),
    );
  const ttl = params.offerTtlSeconds;
  const ttlValido =
    esNumero(ttl) &&
    ttl >= DISPATCH_OFFER_TTL_MIN_SECONDS &&
    ttl <= DISPATCH_OFFER_TTL_MAX_SECONDS;
  const cerca = params.finishingRadiusMeters;
  const cercaValido =
    esNumero(cerca) &&
    Number.isInteger(cerca) &&
    cerca >= DISPATCH_FINISHING_RADIUS_MIN_METERS &&
    cerca <= DISPATCH_FINISHING_RADIUS_MAX_METERS;
  const vencimiento = params.noDriverExpiryMinutes;
  const vencimientoValido =
    esNumero(vencimiento) &&
    Number.isInteger(vencimiento) &&
    vencimiento >= DISPATCH_NO_DRIVER_EXPIRY_MIN_MINUTES &&
    vencimiento <= DISPATCH_NO_DRIVER_EXPIRY_MAX_MINUTES;

  return {
    radiusStepsKm: pasosValidos
      ? [...(pasos as number[])]
      : porDefecto.radiusStepsKm,
    offerTtlSeconds: ttlValido ? ttl : porDefecto.offerTtlSeconds,
    finishingRadiusMeters: cercaValido
      ? cerca
      : porDefecto.finishingRadiusMeters,
    noDriverExpiryMinutes: vencimientoValido
      ? vencimiento
      : porDefecto.noDriverExpiryMinutes,
  };
}

/** ¿Los valores vigentes son todos los de omisión? */
export function sonLosDeOmision(settings: DispatchSettings): boolean {
  const base = dispatchSettingsPorDefecto();
  return (
    settings.offerTtlSeconds === base.offerTtlSeconds &&
    settings.finishingRadiusMeters === base.finishingRadiusMeters &&
    settings.noDriverExpiryMinutes === base.noDriverExpiryMinutes &&
    settings.radiusStepsKm.length === base.radiusStepsKm.length &&
    settings.radiusStepsKm.every((km, i) => km === base.radiusStepsKm[i])
  );
}
