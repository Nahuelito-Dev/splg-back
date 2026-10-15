/**
 * Tareas programadas cuya frecuencia se configura por distribuidora (CU-173).
 * Cada una conserva su tic fijo (`@Cron`) y, en cada tic, atiende sólo a las
 * distribuidoras cuyo intervalo se cumplió.
 */
export interface ScheduledTasksSettings {
  /** Reintentos del despacho (ofertas vencidas y pedidos sin oferta). */
  dispatchRetrySeconds: number;
  /** Activación de reservas con la seña paga. */
  reservationActivationSeconds: number;
  /** Vencimiento de reservas sin seña. */
  unpaidReservationExpirySeconds: number;
  /** Vencimiento de pedidos de MercadoPago sin pagar. */
  unpaidMercadoPagoExpirySeconds: number;
  /** Hora del día (0 a 23) del aviso de vencimientos de flota. */
  fleetAlertHour: number;
}

/** Las tareas que se configuran por intervalo (el aviso de flota va por hora del día). */
export type TareaConIntervalo = Exclude<
  keyof ScheduledTasksSettings,
  'fleetAlertHour'
>;

/** Ciclo de base (tic del `@Cron`) de cada tarea, en segundos. */
export const TIC_SEGUNDOS: Record<TareaConIntervalo, number> = {
  dispatchRetrySeconds: 15,
  reservationActivationSeconds: 5 * 60,
  unpaidReservationExpirySeconds: 60 * 60,
  unpaidMercadoPagoExpirySeconds: 30 * 60,
};

/** Tope de cualquier intervalo: 24 horas. */
export const INTERVALO_MAXIMO_SEGUNDOS = 24 * 60 * 60;

/**
 * Tope del reintento del despacho: 5 minutos. Una oferta vencida queda
 * `offered` hasta que corre el ciclo de su distribuidora; con 24 h el pedido
 * pasaría un día sin re-ofrecerse.
 */
export const REINTENTO_DESPACHO_MAXIMO_SEGUNDOS = 5 * 60;

/** Tope de cada tarea con intervalo. */
export const MAXIMO_SEGUNDOS: Record<TareaConIntervalo, number> = {
  dispatchRetrySeconds: REINTENTO_DESPACHO_MAXIMO_SEGUNDOS,
  reservationActivationSeconds: INTERVALO_MAXIMO_SEGUNDOS,
  unpaidReservationExpirySeconds: INTERVALO_MAXIMO_SEGUNDOS,
  unpaidMercadoPagoExpirySeconds: INTERVALO_MAXIMO_SEGUNDOS,
};

export const HORA_AVISO_FLOTA_POR_DEFECTO = 8;

export function scheduledTasksPorDefecto(): ScheduledTasksSettings {
  return {
    dispatchRetrySeconds: TIC_SEGUNDOS.dispatchRetrySeconds,
    reservationActivationSeconds: TIC_SEGUNDOS.reservationActivationSeconds,
    unpaidReservationExpirySeconds: TIC_SEGUNDOS.unpaidReservationExpirySeconds,
    unpaidMercadoPagoExpirySeconds: TIC_SEGUNDOS.unpaidMercadoPagoExpirySeconds,
    fleetAlertHour: HORA_AVISO_FLOTA_POR_DEFECTO,
  };
}

/** Los parámetros guardados, leídos con defensa (lo ausente o inválido cae al valor por omisión). */
export function scheduledTasksDesde(
  params: Record<string, unknown> | null,
): ScheduledTasksSettings {
  const resultado = scheduledTasksPorDefecto();
  if (!params) return resultado;

  for (const tarea of Object.keys(TIC_SEGUNDOS) as TareaConIntervalo[]) {
    const valor = params[tarea];
    if (
      typeof valor === 'number' &&
      Number.isInteger(valor) &&
      valor > 0 &&
      valor <= MAXIMO_SEGUNDOS[tarea] &&
      valor % TIC_SEGUNDOS[tarea] === 0
    ) {
      resultado[tarea] = valor;
    }
  }
  const hora = params.fleetAlertHour;
  if (
    typeof hora === 'number' &&
    Number.isInteger(hora) &&
    hora >= 0 &&
    hora <= 23
  ) {
    resultado.fleetAlertHour = hora;
  }
  return resultado;
}

/** ¿Los valores vigentes son todos los de omisión? */
export function sonLosDeOmision(settings: ScheduledTasksSettings): boolean {
  const base = scheduledTasksPorDefecto();
  return (Object.keys(base) as Array<keyof ScheduledTasksSettings>).every(
    (campo) => settings[campo] === base[campo],
  );
}
