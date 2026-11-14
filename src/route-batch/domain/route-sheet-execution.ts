/**
 * Reglas de la hoja de ruta en curso (F34 E4, §8.1 y §6.5). Funciones puras:
 * no leen la base ni el reloj (el «ahora» y el «hoy» llegan como argumento).
 */
import { RouteStop, ScheduleParams, scoreSchedule } from './eta';
export { diaHabilSiguiente } from './calendario-laboral';
import {
  CALENDARIO_POR_OMISION,
  CalendarioLaboral,
  esDiaHabil,
  sumarDias,
} from './calendario-laboral';
import { optimizeStops } from './stop-optimizer';
import { RouteBatchStatus } from './route-batch.enums';

/** Cómo va una parada de la hoja en curso, visto desde el chofer y el panel. */
export type StopProgress =
  | 'pending'
  | 'on_the_way'
  | 'delivered'
  | 'failed'
  | 'removed';

/** Estados del pedido que importan acá (los de `OrderStatus`, como texto). */
const ENTREGADO = 'delivered';
const EN_CAMINO = 'on_the_way';

/**
 * El avance de una parada: una activa sigue a su pedido (entregado, en camino o
 * pendiente; un reintento sigue pendiente, con sus intentos aparte); una que
 * salió es «no entregada» si no se entregó en el segundo intento (o por la
 * baja vieja `failed_delivery`), «entregada» si se apagó al cerrarse la hoja
 * con el pedido entregado (salida sin motivo), y «fuera de la hoja» en
 * cualquier otro caso.
 */
export function progresoDeParada(
  parada: { active: boolean; removedReason: string | null },
  estadoDelPedido: string | null,
): StopProgress {
  if (parada.active) {
    if (estadoDelPedido === ENTREGADO) return 'delivered';
    if (estadoDelPedido === EN_CAMINO) return 'on_the_way';
    return 'pending';
  }
  if (
    parada.removedReason === 'rescheduled' ||
    parada.removedReason === 'needs_reschedule' ||
    parada.removedReason === 'failed_delivery'
  ) {
    return 'failed';
  }
  if (parada.removedReason === null && estadoDelPedido === ENTREGADO) {
    return 'delivered';
  }
  return 'removed';
}

export interface RecorridoPartido {
  /** Entregadas, en el orden de la hoja. */
  hechas: string[];
  /** La parada hacia la que va el chofer (una sola a la vez). */
  enCamino: string | null;
  /** Lo que falta, en el orden actual de la hoja. */
  pendientes: string[];
}

/** Separa las paradas activas (en orden) en hechas, la que está en camino y las pendientes. */
export function partirRecorrido(
  paradas: ReadonlyArray<{ orderId: string; progress: StopProgress }>,
): RecorridoPartido {
  const hechas: string[] = [];
  const pendientes: string[] = [];
  let enCamino: string | null = null;
  for (const p of paradas) {
    if (p.progress === 'delivered') hechas.push(p.orderId);
    else if (p.progress === 'on_the_way' && enCamino === null) {
      enCamino = p.orderId;
    } else if (p.progress === 'on_the_way' || p.progress === 'pending') {
      pendientes.push(p.orderId);
    }
  }
  return { hechas, enCamino, pendientes };
}

/** La siguiente parada que la app le propone al chofer: la que está en camino o la primera pendiente. */
export function siguienteParada(r: RecorridoPartido): string | null {
  return r.enCamino ?? r.pendientes[0] ?? null;
}

/** La hoja en curso ya no tiene nada por hacer: todo entregado o fuera de la hoja. */
export function hojaTerminada(r: RecorridoPartido): boolean {
  return r.enCamino === null && r.pendientes.length === 0;
}

/**
 * El orden completo de la hoja: primero lo hecho (no se mueve), después la
 * parada en camino y al final la cola pendiente en el orden dado.
 */
export function ordenCompleto(
  r: RecorridoPartido,
  cola: readonly string[],
): string[] {
  return [...r.hechas, ...(r.enCamino ? [r.enCamino] : []), ...cola];
}

/**
 * Re-optimiza la cola pendiente desde la posición actual (§6.5): nunca se
 * mueven las paradas hechas ni la que está en camino. La que está en camino,
 * si la hay, va primera y fija (el chofer ya va para allá); el resto se
 * reordena con el mismo optimizador de la planificación (2-opt / Or-opt con
 * franjas), dejando tarde lo que no llega (no se saca nada de la hoja en curso).
 * Devuelve la cola sin la parada en camino.
 */
export function reordenarCola(
  stops: readonly RouteStop[],
  params: ScheduleParams,
  enCamino: string | null,
): string[] {
  const libres = stops.filter((s) => s.id !== enCamino);
  if (libres.length <= 1) return libres.map((s) => s.id);
  const fija = enCamino ? stops.find((s) => s.id === enCamino) : undefined;
  const entrada: RouteStop[] = [
    ...(fija ? [{ ...fija, locked: true }] : []),
    ...libres.map((s) => ({ ...s, locked: false })),
  ];
  const r = optimizeStops(entrada, params, { lateStops: 'keep' });
  return [...r.order, ...r.excluded.map((x) => x.id)].filter(
    (id) => id !== enCamino,
  );
}

/**
 * Parada agregada a la hoja en curso (§6.5, D-05): va en la posición de la cola
 * que menos tarde deja (primero menos paradas tarde, después antes se termina,
 * después menos kilómetros); con `posicion` (1 = la próxima después de la que
 * está en camino), ahí. Nunca antes de la parada en camino. Devuelve la cola
 * nueva (sin la parada en camino).
 */
export function insertarEnCola(
  enCamino: RouteStop | null,
  cola: readonly RouteStop[],
  nueva: RouteStop,
  params: ScheduleParams,
  posicion?: number,
): string[] {
  const armar = (i: number) => [...cola.slice(0, i), nueva, ...cola.slice(i)];
  if (posicion !== undefined) {
    const i = Math.min(Math.max(posicion - 1, 0), cola.length);
    return armar(i).map((s) => s.id);
  }
  let mejor: { i: number; late: number; fin: number; km: number } | null = null;
  for (let i = 0; i <= cola.length; i++) {
    const orden = [...(enCamino ? [enCamino] : []), ...armar(i)];
    const r = scoreSchedule(orden, params);
    const c = { i, late: r.lateCount, fin: r.finishMs, km: r.totalKm };
    if (
      !mejor ||
      c.late < mejor.late ||
      (c.late === mejor.late && c.fin < mejor.fin) ||
      (c.late === mejor.late && c.fin === mejor.fin && c.km < mejor.km)
    ) {
      mejor = c;
    }
  }
  return armar(mejor ? mejor.i : cola.length).map((s) => s.id);
}

/**
 * Las paradas que ya fallaron una vez van siempre al final de la cola, en el
 * orden en que fallaron («el 3 pasa a ser el 10»): el chofer sigue con las que
 * todavía no visitó y vuelve a pasar por esas al final. El resto conserva el
 * orden que traía.
 */
export function reintentosAlFinal(
  cola: readonly string[],
  reintentos: ReadonlyMap<string, number>,
): string[] {
  const primeras = cola.filter((id) => !reintentos.has(id));
  const ultimas = cola
    .filter((id) => reintentos.has(id))
    .sort(
      (a, b) =>
        (reintentos.get(a) as number) - (reintentos.get(b) as number) ||
        cola.indexOf(a) - cola.indexOf(b),
    );
  return [...primeras, ...ultimas];
}

/** Qué pasa con una parada que no se pudo entregar (rediseño del 14/11). */
export type ResultadoDelIntento = 'requeued' | 'rescheduled';

/**
 * Primer intento fallido: la parada vuelve al final de la cola del mismo
 * chofer. Segundo: sale de la hoja y el sistema reprograma el pedido para el
 * día hábil siguiente. Ningún pedido vuelve solo al despacho común.
 */
export function resultadoDelIntento(
  intentosPrevios: number,
): ResultadoDelIntento {
  return intentosPrevios >= 1 ? 'rescheduled' : 'requeued';
}

/** La planificación de un día, tal como la ve la reprogramación. */
export interface PlanificacionDelDia {
  status: string;
  cutoffMs: number;
}

/** Hasta cuántos días después de la hoja se busca un día para reprogramar. */
export const HORIZONTE_DE_REPROGRAMACION = 60;

/**
 * El día al que se reprograma un pedido de la hoja (revisión cruzada del 15/11):
 * el PRIMER día hábil después de `desde` cuya planificación siga abierta —sin
 * plan todavía, o `open` con el cierre por delante—, así entra en la propuesta
 * de ese día. Los días que la distribuidora no reparte y sus feriados no
 * cuentan (`cal`). Un día ya propuesto, con hojas confirmadas o cerrado no sirve: el
 * pedido no entraría en ninguna hoja y lo tomaría el despacho común. Cada día
 * que devuelve está verificado; si en `horizonte` días no hay ninguno, `null`
 * (el pedido queda esperando al admin). `planes` tiene que cubrir ese rango.
 */
export function diaDeReprogramacion(
  desde: string,
  planes: ReadonlyMap<string, PlanificacionDelDia>,
  nowMs: number,
  cal: CalendarioLaboral = CALENDARIO_POR_OMISION,
  horizonte = HORIZONTE_DE_REPROGRAMACION,
): string | null {
  const hasta = sumarDias(desde, horizonte);
  for (let dia = sumarDias(desde, 1); dia <= hasta; dia = sumarDias(dia, 1)) {
    if (!esDiaHabil(dia, cal)) continue;
    const plan = planes.get(dia);
    if (!plan || (plan.status === 'open' && plan.cutoffMs > nowMs)) return dia;
  }
  return null;
}

/**
 * ¿Venció la espera en la puerta? `arrivalWaitMinutes` desde «Llegué»; el
 * sistema le sugiere al chofer marcar «No pude entregar» (no lo hace solo).
 */
export function esperaVencida(
  arrivedAtMs: number | null,
  nowMs: number,
  waitMinutes: number,
): boolean {
  return arrivedAtMs !== null && nowMs - arrivedAtMs >= waitMinutes * 60_000;
}

/**
 * El chofer marcó «en camino» una parada que no es la siguiente (desvío,
 * §8.1): pasa a ser la próxima y el resto de la cola conserva su orden (después
 * se re-optimiza desde ahí).
 */
export function colaConDesvio(
  pendientes: readonly string[],
  elegida: string,
): string[] {
  return [elegida, ...pendientes.filter((id) => id !== elegida)];
}

/** Lo que falta en el camión para una garrafa (D-04: advierte, no bloquea). */
export interface Faltante {
  gasCylinderId: string;
  type: string | null;
  required: number;
  onTruck: number;
  missing: number;
}

/** Llenas que pide la hoja contra las que tiene el camión, por garrafa. */
export function faltantesDeCarga(
  pedido: ReadonlyArray<{
    gasCylinderId: string;
    type: string | null;
    units: number;
  }>,
  enCamion: ReadonlyMap<string, number>,
): Faltante[] {
  return pedido
    .map((p) => {
      const onTruck = enCamion.get(p.gasCylinderId) ?? 0;
      return {
        gasCylinderId: p.gasCylinderId,
        type: p.type,
        required: p.units,
        onTruck,
        missing: p.units - onTruck,
      };
    })
    .filter((f) => f.missing > 0);
}

/** Por qué no se puede iniciar la hoja (antes de mirar la carga y los pedidos). */
export type MotivoParaNoIniciar =
  | 'not_confirmed'
  | 'not_today'
  | 'wrong_driver';

/**
 * Reglas del inicio (§8.1 punto 1): la hoja está confirmada, es de hoy y la
 * inicia su chofer (o un admin en su nombre: `actorDeliveryId` null). Una hoja
 * ya iniciada por el mismo chofer no es un error: el inicio es idempotente y
 * lo resuelve quien llama antes de esto.
 */
export function motivoParaNoIniciar(h: {
  status: RouteBatchStatus;
  planDate: string;
  hoy: string;
  sheetDeliveryId: string | null;
  actorDeliveryId: string | null;
}): MotivoParaNoIniciar | null {
  if (h.actorDeliveryId !== null && h.actorDeliveryId !== h.sheetDeliveryId) {
    return 'wrong_driver';
  }
  if (h.status !== RouteBatchStatus.CONFIRMED) return 'not_confirmed';
  if (h.planDate !== h.hoy) return 'not_today';
  return null;
}

/** D-07: la parada no entregada vuelve al despacho del día si su franja sigue abierta. */
export function franjaAbierta(
  slotEndMs: number | null,
  nowMs: number,
): boolean {
  return slotEndMs === null || nowMs < slotEndMs;
}

/** Distancia en metros entre dos puntos (haversine): el umbral del recálculo por GPS. */
export function metrosEntre(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lo último que disparó un recálculo de la hora estimada de una hoja. */
export interface UltimoRecalculo {
  atMs: number;
  lat: number;
  lng: number;
}

/**
 * ¿Toca recalcular la hora estimada con esta posición (§8.2)? Siempre la
 * primera vez; después, si pasaron `minSeconds` o el chofer se movió
 * `minMeters` o más. Nunca dos recálculos en menos de `pisoSegundos` (aunque
 * se mueva rápido: el GPS manda cada pocos segundos).
 */
export function tocaRecalcular(
  ultimo: UltimoRecalculo | null,
  pos: { lat: number; lng: number },
  nowMs: number,
  minSeconds: number,
  minMeters: number,
  pisoSegundos = 15,
): boolean {
  if (!ultimo) return true;
  const transcurrido = (nowMs - ultimo.atMs) / 1000;
  if (transcurrido < pisoSegundos) return false;
  if (transcurrido >= minSeconds) return true;
  return metrosEntre(ultimo, pos) >= minMeters;
}
