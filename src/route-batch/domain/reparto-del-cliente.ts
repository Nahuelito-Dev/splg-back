/**
 * Lo que el cliente puede saber del reparto de SU pedido (asistente del chat,
 * «¿cuánto falta?», «¿ya salió?»). Funciones puras: no leen la base ni el
 * reloj (el «hoy» llega como argumento).
 *
 * Sólo datos del propio pedido: si va en una hoja de ruta, si el viaje
 * arrancó, cuántas entregas hay antes que la suya (un número, nunca cuáles),
 * la franja estimada redondeada (nunca la hora puntual) y si se reprogramó o
 * pasó al final del recorrido. Nada de otras paradas ni de la posición del
 * chofer.
 */
import { estimatedWindow } from './eta';

const MS_POR_MINUTO = 60_000;

/** A cuántos minutos se redondea la franja estimada que se le dice al cliente. */
export const REDONDEO_DE_LA_VENTANA_MIN = 5;

/** Motivos de salida de la hoja con los que el pedido queda para otro día (o esperando fecha). */
const SALIDAS_SIN_ENTREGA: readonly string[] = [
  'rescheduled',
  'needs_reschedule',
  'sheet_closed',
];

/** Estados del pedido que ya no tienen reparto por delante. */
const TERMINADOS: readonly string[] = ['delivered', 'cancelled'];

/**
 * - `sin_hoja_de_ruta`: el pedido sigue vigente pero no va en ninguna hoja
 *   confirmada ni en curso (no hay hora estimada).
 * - `en_hoja_sin_salir`: va en una hoja confirmada; el viaje no arrancó.
 * - `en_viaje`: va en la hoja en curso (el chofer ya salió).
 * - `reprogramado`: no se pudo entregar y quedó para otro día.
 * - `sin_fecha_nueva`: salió del recorrido sin entregarse y todavía no tiene
 *   día nuevo (lo decide el equipo).
 */
export type SituacionDelReparto =
  | 'sin_hoja_de_ruta'
  | 'en_hoja_sin_salir'
  | 'en_viaje'
  | 'reprogramado'
  | 'sin_fecha_nueva';

export interface VentanaMs {
  startMs: number;
  endMs: number;
}

/** Lo que se lee de la base para un pedido (ya filtrado por empresa y cliente). */
export interface DatosDelReparto {
  /** `OrderStatus` como texto. */
  estadoDelPedido: string;
  /** Fecha de entrega del pedido (AAAA-MM-DD). */
  fechaDelPedido: string | null;
  /** La parada activa en una hoja planificada confirmada o en curso. */
  hoja: {
    enCurso: boolean;
    /** Día de la hoja (AAAA-MM-DD). */
    fecha: string | null;
    etaMs: number | null;
    /** La franja estimada que ya se le avisó (push), si hay. */
    ventanaAvisada: VentanaMs | null;
    /** La franja comprada (o la jornada, si no tiene), para armar la estimada. */
    franja: VentanaMs | null;
    intentosFallidos: number;
    /** Paradas activas de la hoja antes que ésta y todavía sin entregar. */
    entregasAntes: number;
  } | null;
  /** La última vez que el pedido salió de una hoja planificada, si salió. */
  ultimaSalida: { motivo: string | null; fechaDeLaHoja: string | null } | null;
}

export interface RepartoCalculado {
  situacion: SituacionDelReparto;
  /** Día de la hoja en la que va (AAAA-MM-DD). */
  diaDelReparto: string | null;
  viajeIniciado: boolean;
  /** Sólo con el viaje en curso: entregas pendientes antes que la suya. */
  entregasAntes: number | null;
  /** Franja estimada, redondeada a `REDONDEO_DE_LA_VENTANA_MIN`. */
  ventana: VentanaMs | null;
  /** Primer intento fallido: el chofer vuelve a pasar al final del recorrido. */
  pasoAlFinalDelRecorrido: boolean;
  /** Día al que se reprogramó (AAAA-MM-DD). */
  reprogramadoPara: string | null;
}

/** Redondea la franja hacia afuera (inicio para abajo, fin para arriba): nunca se achica. */
export function redondearVentana(
  v: VentanaMs,
  minutos = REDONDEO_DE_LA_VENTANA_MIN,
): VentanaMs {
  const paso = minutos * MS_POR_MINUTO;
  return {
    startMs: Math.floor(v.startMs / paso) * paso,
    endMs: Math.ceil(v.endMs / paso) * paso,
  };
}

/**
 * La franja estimada del cliente: la que ya se le avisó si la hay (la misma
 * que vio en la app); si no, la de la hora estimada de la parada con
 * `estimatedWindow` (dentro de la franja comprada). Sin hora estimada o sin
 * franja, ninguna.
 */
export function ventanaDelCliente(
  hoja: NonNullable<DatosDelReparto['hoja']>,
  mediaVentanaMinutos: number,
): VentanaMs | null {
  if (hoja.ventanaAvisada) return hoja.ventanaAvisada;
  if (hoja.etaMs === null || !hoja.franja) return null;
  const v = estimatedWindow(
    hoja.etaMs,
    hoja.franja.startMs,
    hoja.franja.endMs,
    mediaVentanaMinutos,
  );
  return { startMs: v.startMs, endMs: v.endMs };
}

/**
 * El reparto de un pedido como lo puede saber su cliente; `null` si ya se
 * entregó o se canceló (el estado alcanza).
 */
export function calcularReparto(
  d: DatosDelReparto,
  o: { hoy: string; mediaVentanaMinutos: number },
): RepartoCalculado | null {
  if (TERMINADOS.includes(d.estadoDelPedido)) return null;
  const base: RepartoCalculado = {
    situacion: 'sin_hoja_de_ruta',
    diaDelReparto: null,
    viajeIniciado: false,
    entregasAntes: null,
    ventana: null,
    pasoAlFinalDelRecorrido: false,
    reprogramadoPara: null,
  };
  if (d.hoja) {
    const v = ventanaDelCliente(d.hoja, o.mediaVentanaMinutos);
    const enCurso = d.hoja.enCurso;
    return {
      ...base,
      situacion: enCurso ? 'en_viaje' : 'en_hoja_sin_salir',
      diaDelReparto: d.hoja.fecha,
      viajeIniciado: enCurso,
      entregasAntes: enCurso
        ? d.estadoDelPedido === 'on_the_way'
          ? 0
          : d.hoja.entregasAntes
        : null,
      ventana: v ? redondearVentana(v) : null,
      pasoAlFinalDelRecorrido: enCurso && d.hoja.intentosFallidos >= 1,
    };
  }
  const salida = d.ultimaSalida;
  if (salida && salida.motivo && SALIDAS_SIN_ENTREGA.includes(salida.motivo)) {
    const nueva = d.fechaDelPedido;
    if (
      nueva !== null &&
      salida.fechaDeLaHoja !== null &&
      nueva > salida.fechaDeLaHoja
    ) {
      // Una fecha nueva que ya pasó no se le dice como si fuera a venir.
      if (nueva < o.hoy) return base;
      return { ...base, situacion: 'reprogramado', reprogramadoPara: nueva };
    }
    return { ...base, situacion: 'sin_fecha_nueva' };
  }
  return base;
}
