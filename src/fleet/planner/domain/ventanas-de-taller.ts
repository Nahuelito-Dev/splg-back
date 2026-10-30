import {
  diaArgentino,
  diasEntre,
  inicioDelDiaArgentino,
  sumarDias,
} from '../../../common/utils/dias-argentina';
import { esDiaDeTaller } from './dias-de-taller';
import type { EvaluatedWindow } from '../../entities/maintenance-planning-case.entity';

const MS_POR_HORA = 3_600_000;

/**
 * El día de un vencimiento. Una fecha límite se guarda como un día de calendario a medianoche UTC
 * (`normalizarFechaCalendario`): ésa es una fecha sin hora y se lee tal cual; el resto (una
 * proyección por kilometraje) es un instante y se lee en hora argentina.
 */
export function diaDelVencimiento(fecha: Date): string {
  const esDeCalendario =
    fecha.getUTCHours() === 0 &&
    fecha.getUTCMinutes() === 0 &&
    fecha.getUTCSeconds() === 0 &&
    fecha.getUTCMilliseconds() === 0;
  return esDeCalendario
    ? fecha.toISOString().slice(0, 10)
    : diaArgentino(fecha);
}

export interface ParametrosDeVentanas {
  hoy: Date;
  /** Fecha proyectada del vencimiento: la ventana tiene que caer antes. */
  proyectado: Date;
  /** Días de aviso mínimos entre hoy y la ventana. */
  minLeadDays: number;
  /** Hasta cuántos días hacia adelante se busca. */
  horizonDays: number;
  workshopStartHour: number;
  workshopEndHour: number;
  /** Días de la semana en que atiende el taller (máscara: bit n = día n, 0 = domingo). */
  workshopDays: number;
}

export interface VentanaCandidata {
  day: string;
  start: Date;
  end: Date;
  /** Cae después del vencimiento proyectado: la tarea ya estaba vencida o por vencer sin margen. */
  urgent?: boolean;
}

/** Pedidos esperados ese día en la zona del vehículo. */
export type DemandaPorDia = (dia: string) => number;
/** Vehículos que quedarían activos en la zona ese día con éste en el taller; `null` si no tiene zona. */
export type UnidadesPorDia = (dia: string) => number | null;

/**
 * Las ventanas de taller posibles: una por día hábil del taller (los días de
 * la semana que atiende, sin feriados), de `workshopStartHour` a
 * `workshopEndHour` (hora argentina), desde `hoy + minLeadDays` hasta el día
 * anterior al vencimiento proyectado o el horizonte, lo que llegue primero.
 * Si no queda ninguna antes del vencimiento, devuelve las del horizonte
 * marcadas `urgent`.
 */
export function enumerarVentanas(p: ParametrosDeVentanas): VentanaCandidata[] {
  const hoyDia = diaArgentino(p.hoy);
  const primero = sumarDias(hoyDia, p.minLeadDays);
  const ultimoPorHorizonte = sumarDias(hoyDia, p.horizonDays);
  const diaDelVto = diaDelVencimiento(p.proyectado);

  const habiles: VentanaCandidata[] = [];
  for (let dia = primero; dia <= ultimoPorHorizonte; dia = sumarDias(dia, 1)) {
    if (!esDiaDeTaller(dia, p.workshopDays)) continue;
    const inicio = inicioDelDiaArgentino(dia);
    if (!inicio) continue;
    habiles.push({
      day: dia,
      start: new Date(inicio.getTime() + p.workshopStartHour * MS_POR_HORA),
      end: new Date(inicio.getTime() + p.workshopEndHour * MS_POR_HORA),
    });
  }
  const aTiempo = habiles.filter((v) => v.day < diaDelVto);
  if (aTiempo.length > 0) return aTiempo;
  // Sin margen (vencida o por vencer): se negocia igual desde el primer día
  // hábil posible, aunque sea después del vencimiento.
  return habiles.map((v) => ({ ...v, urgent: true }));
}

export interface ResultadoDeEvaluacion {
  /** Todas las ventanas, en el orden en que se ofrecen las elegidas y después el resto por fecha. */
  evaluadas: EvaluatedWindow[];
  /** Cuántas quedaron elegidas para ofrecer. */
  ofrecidas: number;
  /** Cuántas se descartaron por dejar la zona bajo el mínimo. */
  descartadasPorCobertura: number;
}

/**
 * Descarta las ventanas que dejarían la zona bajo `minVehiclesPerZone`, ordena
 * el resto por demanda esperada (menor primero, y la fecha más próxima de
 * desempate) y elige las `topN` mejores. Devuelve el cuadro completo: lo que
 * se ofrece va primero, y cada descartada lleva su motivo.
 */
export function evaluarVentanas(
  candidatas: readonly VentanaCandidata[],
  demanda: DemandaPorDia,
  unidades: UnidadesPorDia,
  minVehiclesPerZone: number,
  topN: number,
): ResultadoDeEvaluacion {
  const conDatos = candidatas.map((c) => ({
    c,
    demand: demanda(c.day),
    unitsLeft: unidades(c.day),
  }));
  const factibles = conDatos.filter(
    (x) => x.unitsLeft === null || x.unitsLeft >= minVehiclesPerZone,
  );
  const sinCobertura = conDatos.filter((x) => !factibles.includes(x));
  // Lo urgente se ofrece por fecha (lo antes posible); lo demás, por menor demanda.
  factibles.sort((a, b) =>
    a.c.urgent || b.c.urgent
      ? a.c.day < b.c.day
        ? -1
        : 1
      : a.demand - b.demand || (a.c.day < b.c.day ? -1 : 1),
  );

  const aEvaluada = (
    x: (typeof conDatos)[number],
    offered: boolean,
    discardReason: EvaluatedWindow['discardReason'],
  ): EvaluatedWindow => ({
    start: x.c.start.toISOString(),
    end: x.c.end.toISOString(),
    demand: Math.round(x.demand * 100) / 100,
    unitsLeft: x.unitsLeft,
    urgent: x.c.urgent === true,
    offered,
    discardReason,
  });

  const elegidas = factibles
    .slice(0, topN)
    .map((x) => aEvaluada(x, true, null));
  const resto = factibles
    .slice(topN)
    .map((x) => aEvaluada(x, false, 'not_selected'));
  const descartadas = sinCobertura.map((x) => aEvaluada(x, false, 'coverage'));
  return {
    evaluadas: [...elegidas, ...resto, ...descartadas],
    ofrecidas: elegidas.length,
    descartadasPorCobertura: descartadas.length,
  };
}

/** Días que faltan de `hoy` al día del vencimiento (negativo si ya pasó). */
export function diasHasta(hoy: Date, fecha: Date): number {
  return diasEntre(diaArgentino(hoy), diaDelVencimiento(fecha));
}
