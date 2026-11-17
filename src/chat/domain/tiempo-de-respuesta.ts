import {
  atiendeLaEmpresa,
  type HorarioDeLaEmpresa,
  proximaAtencion,
  textoDeLaProximaAtencion,
} from './horario-de-la-empresa';
import { mediana } from './metricas';

/**
 * Tiempo de respuesta esperado (tanda 7c, como el «Solemos responder en…» de
 * Intercom): lo que ve el cliente o el chofer antes de escribir. Sale de la
 * mediana del tiempo de primera respuesta, en minutos hábiles, de las
 * conversaciones del canal de los últimos 14 días; con menos de 10
 * respondidas, del objetivo que se puso la empresa. Fuera de horario, cuándo
 * vuelve a atender.
 */

/** Días que mira hacia atrás. */
export const DIAS_DEL_TIEMPO_ESPERADO = 14;

/** Conversaciones (respondidas y esperando) que hacen falta para creerle a la mediana. */
export const MINIMO_DE_RESPONDIDAS = 10;

/**
 * Lo que se calcula con la historia (lo caro, lo que se guarda en caché). Las
 * que esperan respuesta ahora entran con su espera actual (en minutos
 * hábiles) como mínimo: así el número no es optimista cuando el equipo está
 * atrasado.
 */
export interface HistoriaDeRespuestas {
  /** Conversaciones respondidas en el período. */
  respondidas: number;
  /** Abiertas que esperan la primera respuesta ahora. */
  esperando: number;
  /** Mediana de las dos juntas (respondidas y esperando), en minutos hábiles. */
  mediana: number | null;
  /** Mediana de la espera actual de las que esperan; `null` si no hay. */
  medianaDeEspera: number | null;
}

export function historiaDeRespuestas(
  respondidas: readonly number[],
  esperas: readonly number[] = [],
): HistoriaDeRespuestas {
  return {
    respondidas: respondidas.length,
    esperando: esperas.length,
    mediana: mediana([...respondidas, ...esperas]),
    medianaDeEspera: mediana(esperas),
  };
}

/**
 * De dónde salen los minutos: `history`, la mediana de respondidas y
 * esperando juntas (con 10 o más entre las dos); `target`, el objetivo de la
 * empresa (con menos); `waiting`, con menos pero con la espera actual por
 * encima del objetivo (no se promete menos de lo que ya están esperando).
 */
export type BaseDelTiempoEsperado = 'history' | 'target' | 'waiting';

export interface TiempoEsperado {
  /** La empresa lo muestra (si no, el resto viene vacío). */
  enabled: boolean;
  openNow: boolean;
  /** Minutos que se prometen (redondeados para mostrar); `null` fuera de horario o apagado. */
  minutes: number | null;
  /** De dónde salen los minutos (`BaseDelTiempoEsperado`). */
  basis: BaseDelTiempoEsperado | null;
  /** Cuándo vuelve a atender; `null` si atiende ahora (o si no vuelve: sin franjas futuras). */
  nextOpenAt: Date | null;
  /** El texto listo para mostrar; `null` si está apagado. */
  text: string | null;
}

/** Minutos para mostrar: hasta la hora, el minuto de arriba; desde la hora, horas redondeadas. */
export function minutosParaMostrar(minutos: number): number {
  const m = Math.max(1, Math.ceil(minutos));
  return m < 60 ? m : Math.max(1, Math.round(m / 60)) * 60;
}

/** «12 min», «1 h», «3 h». */
export function duracionEnTexto(minutos: number): string {
  return minutos < 60 ? `${minutos} min` : `${Math.round(minutos / 60)} h`;
}

export const APAGADO: TiempoEsperado = {
  enabled: false,
  openNow: false,
  minutes: null,
  basis: null,
  nextOpenAt: null,
  text: null,
};

export function tiempoEsperado(entrada: {
  habilitado: boolean;
  historia: HistoriaDeRespuestas;
  objetivoMinutos: number;
  horario: HorarioDeLaEmpresa;
  ahora: Date;
}): TiempoEsperado {
  if (!entrada.habilitado) return { ...APAGADO };
  const { horario, ahora } = entrada;
  if (!atiendeLaEmpresa(horario, ahora)) {
    const abre = proximaAtencion(horario, ahora);
    return {
      enabled: true,
      openNow: false,
      minutes: null,
      basis: null,
      nextOpenAt: abre,
      text: abre
        ? `Ahora estamos fuera de horario. Te respondemos ${textoDeLaProximaAtencion(abre, horario.zona, ahora)}.`
        : 'Ahora estamos fuera de horario.',
    };
  }
  const h = entrada.historia;
  const conHistoria =
    h.respondidas + h.esperando >= MINIMO_DE_RESPONDIDAS && h.mediana !== null;
  const esperaPorEncima =
    h.medianaDeEspera !== null && h.medianaDeEspera > entrada.objetivoMinutos;
  const basis: BaseDelTiempoEsperado = conHistoria
    ? 'history'
    : esperaPorEncima
      ? 'waiting'
      : 'target';
  const minutos = minutosParaMostrar(
    basis === 'history'
      ? (h.mediana as number)
      : basis === 'waiting'
        ? (h.medianaDeEspera as number)
        : entrada.objetivoMinutos,
  );
  return {
    enabled: true,
    openNow: true,
    minutes: minutos,
    basis,
    nextOpenAt: null,
    text: `Solemos responder en ~${duracionEnTexto(minutos)}`,
  };
}
