import Decimal from 'decimal.js';
import { diaArgentino } from '../../common/utils/dias-argentina';

export interface MantenimientoHecho {
  performedAt: Date;
  cost: number;
}

/** Prima de una póliza y su vigencia; `validFrom` nulo = sin inicio registrado. */
export interface Poliza {
  validFrom: Date | null;
  dueAt: Date;
  cost: number;
}

export interface CargaParaCosto {
  loadedAt: Date;
  totalAmount: number;
  odometerKm: number;
}

export interface MultaPagada {
  /** `YYYY-MM-DD` */
  paidAt: string;
  paidAmount: number;
}

export interface SiniestroCerrado {
  closedAt: Date;
  repairCost: number;
  insurerReimbursement: number;
}

export interface EntradasDeCosto {
  maintenance: MantenimientoHecho[];
  insurance: Poliza[];
  fuel: CargaParaCosto[];
  fines: MultaPagada[];
  accidents: SiniestroCerrado[];
  /** Suma del registro de uso diario en el rango; 0 si no hay registros. */
  usageKm: number;
}

export interface Rubros {
  maintenance: number;
  insurance: number;
  fuel: number;
  fines: number;
  accidents: number;
  total: number;
}

export interface MesDeCosto extends Rubros {
  /** `YYYY-MM` */
  month: string;
}

export type FuenteDeKm = 'usage_log' | 'odometer' | 'none';

export interface CostoDeVehiculo extends Rubros {
  /** Alguna póliza no tenía inicio de vigencia y se prorrateó con un año hacia atrás. */
  insuranceEstimated: boolean;
  km: number;
  kmSource: FuenteDeKm;
  costPerKm: number | null;
  monthly: MesDeCosto[];
}

const UN_DIA = 24 * 60 * 60 * 1000;
const UN_ANIO_EN_DIAS = 365;
/** Tope del rango que se calcula: cinco años. */
export const MAXIMO_DE_DIAS_DEL_RANGO = 366 * 5;

/** Días enteros desde la época de un `YYYY-MM-DD`. */
export function numeroDeDia(dia: string): number {
  const [a, m, d] = dia.split('-').map(Number);
  return Date.UTC(a, m - 1, d) / UN_DIA;
}

function diaDeCalendario(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

function redondear(valor: Decimal): number {
  return valor.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

function mesDe(dia: string): string {
  return dia.slice(0, 7);
}

/** Meses `YYYY-MM` que toca el rango, en orden. */
export function mesesDelRango(desdeDia: string, hastaDia: string): string[] {
  const meses: string[] = [];
  let [a, m] = desdeDia.split('-').map(Number);
  const [af, mf] = hastaDia.split('-').map(Number);
  while (a < af || (a === af && m <= mf)) {
    meses.push(`${a}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      a++;
    }
  }
  return meses;
}

function ultimoDiaDelMes(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${mes}-${String(dia).padStart(2, '0')}`;
}

/** Prima × días de la vigencia que caen en `[desdeDia, hastaDia]` / días de la vigencia. */
function primaProrrateada(
  poliza: Poliza,
  desdeDia: string,
  hastaDia: string,
): { monto: Decimal; estimada: boolean } {
  const fin = numeroDeDia(diaDeCalendario(poliza.dueAt));
  const estimada = poliza.validFrom === null;
  const inicio = poliza.validFrom
    ? numeroDeDia(diaDeCalendario(poliza.validFrom))
    : fin - UN_ANIO_EN_DIAS;
  const diasDeVigencia = fin - inicio + 1;
  if (diasDeVigencia <= 0) return { monto: new Decimal(0), estimada };
  const solape =
    Math.min(fin, numeroDeDia(hastaDia)) -
    Math.max(inicio, numeroDeDia(desdeDia)) +
    1;
  if (solape <= 0) return { monto: new Decimal(0), estimada };
  return {
    monto: new Decimal(poliza.cost).times(solape).div(diasDeVigencia),
    estimada,
  };
}

function rubrosEnRango(
  e: EntradasDeCosto,
  desdeDia: string,
  hastaDia: string,
): { rubros: Rubros; estimado: boolean } {
  const enRango = (dia: string) => dia >= desdeDia && dia <= hastaDia;
  const suma = (valores: Decimal[]) =>
    valores.reduce((s, v) => s.plus(v), new Decimal(0));

  const maintenance = suma(
    e.maintenance
      .filter((t) => enRango(diaArgentino(t.performedAt)))
      .map((t) => new Decimal(t.cost)),
  );
  const fuel = suma(
    e.fuel
      .filter((c) => enRango(diaArgentino(c.loadedAt)))
      .map((c) => new Decimal(c.totalAmount)),
  );
  const fines = suma(
    e.fines
      .filter((m) => enRango(m.paidAt))
      .map((m) => new Decimal(m.paidAmount)),
  );
  const accidents = suma(
    e.accidents
      .filter((s) => enRango(diaArgentino(s.closedAt)))
      .map((s) => new Decimal(s.repairCost).minus(s.insurerReimbursement)),
  );
  let estimado = false;
  const primas = e.insurance.map((p) => {
    const r = primaProrrateada(p, desdeDia, hastaDia);
    if (r.estimada && r.monto.gt(0)) estimado = true;
    return r.monto;
  });
  const insurance = suma(primas);
  const total = maintenance
    .plus(insurance)
    .plus(fuel)
    .plus(fines)
    .plus(accidents);

  return {
    rubros: {
      maintenance: redondear(maintenance),
      insurance: redondear(insurance),
      fuel: redondear(fuel),
      fines: redondear(fines),
      accidents: redondear(accidents),
      total: redondear(total),
    },
    estimado,
  };
}

/**
 * Km del rango: el registro de uso diario y, si no hay, la diferencia de
 * kilometraje entre las cargas de combustible del rango.
 */
function kilometros(
  e: EntradasDeCosto,
  desdeDia: string,
  hastaDia: string,
): { km: number; fuente: FuenteDeKm } {
  if (e.usageKm > 0) return { km: e.usageKm, fuente: 'usage_log' };
  const odometros = e.fuel
    .filter((c) => {
      const dia = diaArgentino(c.loadedAt);
      return dia >= desdeDia && dia <= hastaDia;
    })
    .map((c) => c.odometerKm);
  if (odometros.length >= 2) {
    const km = Math.max(...odometros) - Math.min(...odometros);
    if (km > 0) return { km, fuente: 'odometer' };
  }
  return { km: 0, fuente: 'none' };
}

/**
 * CU-203: costo total de un vehículo entre dos días (`YYYY-MM-DD`, inclusivos,
 * en hora argentina): mantenimiento, seguros prorrateados por días, combustible,
 * multas pagadas que no se imputaron al chofer y el costo neto de los
 * siniestros cerrados. Función pura: quien llama arma las entradas ya
 * filtradas (multas no imputadas, siniestros cerrados).
 */
export function calcularCostoDeVehiculo(
  entradas: EntradasDeCosto,
  desdeDia: string,
  hastaDia: string,
): CostoDeVehiculo {
  const { rubros, estimado } = rubrosEnRango(entradas, desdeDia, hastaDia);
  const { km, fuente } = kilometros(entradas, desdeDia, hastaDia);

  const monthly = mesesDelRango(desdeDia, hastaDia).map((mes) => {
    const inicioMes = `${mes}-01`;
    const desde = inicioMes < desdeDia ? desdeDia : inicioMes;
    const finMes = ultimoDiaDelMes(mes);
    const hasta = finMes > hastaDia ? hastaDia : finMes;
    return {
      month: mesDe(desde),
      ...rubrosEnRango(entradas, desde, hasta).rubros,
    };
  });

  return {
    ...rubros,
    insuranceEstimated: estimado,
    km,
    kmSource: fuente,
    costPerKm: km > 0 ? redondear(new Decimal(rubros.total).div(km)) : null,
    monthly,
  };
}
