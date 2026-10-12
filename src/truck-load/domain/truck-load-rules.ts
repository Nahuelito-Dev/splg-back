import { MovimientoDeStock } from '../../stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
} from '../../stock/domain/stock.enums';
import { CargaInvalidaError } from './errors/truck-load.errors';
import { TruckLoadStatus } from './truck-load.enums';

/** Acciones sobre una carga y los estados desde los que se pueden hacer. */
export type AccionDeCarga =
  | 'editar'
  | 'salir'
  | 'reponer'
  | 'declarar'
  | 'cerrar'
  | 'cancelar';

const DESDE: Record<AccionDeCarga, readonly TruckLoadStatus[]> = {
  editar: [TruckLoadStatus.LOADING],
  salir: [TruckLoadStatus.LOADING],
  reponer: [TruckLoadStatus.ON_ROUTE],
  // Se puede volver a declarar mientras no se cerró la rendición.
  declarar: [TruckLoadStatus.ON_ROUTE, TruckLoadStatus.RETURNED],
  cerrar: [TruckLoadStatus.RETURNED],
  cancelar: [TruckLoadStatus.LOADING],
};

export function puedeHacer(
  accion: AccionDeCarga,
  estado: TruckLoadStatus,
): boolean {
  return DESDE[accion].includes(estado);
}

export interface RenglonDeCarga {
  gasCylinderId: string;
  loadedFull: number;
  loadedEmpty: number;
}

/** Sin garrafas repetidas, cantidades enteras >= 0 y algo para cargar. */
export function validarRenglones(renglones: RenglonDeCarga[]): void {
  const vistos = new Set<string>();
  for (const r of renglones) {
    if (vistos.has(r.gasCylinderId)) {
      throw new CargaInvalidaError(
        'Hay dos renglones para la misma garrafa: sumá las cantidades en uno solo',
      );
    }
    vistos.add(r.gasCylinderId);
    if (
      !Number.isInteger(r.loadedFull) ||
      !Number.isInteger(r.loadedEmpty) ||
      r.loadedFull < 0 ||
      r.loadedEmpty < 0
    ) {
      throw new CargaInvalidaError(
        'Las cantidades tienen que ser enteros de cero o más',
      );
    }
  }
}

/** Para salir, la carga tiene que llevar algo. */
export function validarQueLlevaAlgo(renglones: RenglonDeCarga[]): void {
  if (!renglones.some((r) => r.loadedFull + r.loadedEmpty > 0)) {
    throw new CargaInvalidaError(
      'La carga no tiene garrafas: cargá al menos un renglón antes de confirmar la salida',
    );
  }
}

export interface FigurasDeRenglon {
  loadedFull: number;
  reloadedFull: number;
  deliveredFull: number;
  loadedEmpty: number;
  collectedEmpty: number;
}

/**
 * Lo que tendría que volver al depósito (D6, canje 1 a 1 inferido):
 *  - llenas = cargadas + repuestas − entregadas;
 *  - vacías = cargadas para canje + recolectadas.
 */
export function esperadoDe(f: FigurasDeRenglon): {
  expectedFull: number;
  expectedEmpty: number;
} {
  return {
    expectedFull: f.loadedFull + f.reloadedFull - f.deliveredFull,
    expectedEmpty: f.loadedEmpty + f.collectedEmpty,
  };
}

/** Declarado menos esperado: negativo es faltante, positivo es sobrante. */
export function diferenciaDe(declarado: number, esperado: number): number {
  return declarado - esperado;
}

export interface DeclaracionDeRenglon {
  gasCylinderId: string;
  declaredFull: number;
  declaredEmpty: number;
}

/**
 * La declaración de vuelta cubre TODOS los renglones de la carga (olvidarse
 * de uno sería declarar cero), sin repetidos ni garrafas ajenas a la carga
 * salvo las que se agregan a propósito (`permitirNuevas`).
 */
export function validarDeclaracion(
  declaradas: DeclaracionDeRenglon[],
  idsDeLaCarga: string[],
): void {
  const vistos = new Set<string>();
  for (const d of declaradas) {
    if (vistos.has(d.gasCylinderId)) {
      throw new CargaInvalidaError(
        'Hay dos renglones declarados para la misma garrafa',
      );
    }
    vistos.add(d.gasCylinderId);
    if (
      !Number.isInteger(d.declaredFull) ||
      !Number.isInteger(d.declaredEmpty) ||
      d.declaredFull < 0 ||
      d.declaredEmpty < 0
    ) {
      throw new CargaInvalidaError(
        'Lo declarado tiene que ser enteros de cero o más',
      );
    }
  }
  const faltan = idsDeLaCarga.filter((id) => !vistos.has(id));
  if (faltan.length > 0) {
    throw new CargaInvalidaError(
      `Falta declarar ${faltan.length} garrafa(s) de la carga: declará todas, aunque vuelvan en cero`,
    );
  }
}

export interface RenglonDeCierre {
  gasCylinderId: string;
  /** Lo que el sistema espera que vuelva. */
  expectedFull: number;
  expectedEmpty: number;
  declaredFull: number;
  declaredEmpty: number;
  /** Lo que de verdad hay en el camión según el libro (bajo lock). */
  balanceFull: number;
  balanceEmpty: number;
  /** Defectuosas que hay en el camión (una rotura registrada en ruta). */
  balanceDefective?: number;
}

/**
 * Garrafas que el camión entregó DESPUÉS de declarar la vuelta (`entregas` son
 * los movimientos del camión desde `returnedAt`). Si hay alguna, la declaración
 * quedó vieja y el cierre se rechaza: hay que volver a declarar.
 */
export function entregasTardias(
  entregas: Array<{ deliveredFull: number }>,
): number {
  return entregas.reduce((n, m) => n + m.deliveredFull, 0);
}

export interface RenglonDeCargaParaCierre {
  gasCylinderId: string;
  loadedFull: number;
  reloadedFull: number;
  loadedEmpty: number;
  declaredReturnFull: number | null;
  declaredReturnEmpty: number | null;
}

export interface MovidoDelCamion {
  deliveredFull: number;
  collectedEmpty: number;
}

export interface SaldoDeGarrafaEnCamion {
  full: number;
  empty: number;
  defective: number;
}

/**
 * Los renglones que alimentan a `planDeCierre`: los de la carga con su esperado
 * (cargado + repuesto - entregado) y, por cada garrafa que el camión tiene sin
 * renglón (una transferencia a mano), uno en cero para que se rinda igual.
 * Lo comparten el cierre real y la vista previa del detalle.
 */
export function renglonesDeCierre(args: {
  items: RenglonDeCargaParaCierre[];
  sinRenglon: string[];
  movidos: Map<string, MovidoDelCamion>;
  saldoDe: (gasCylinderId: string) => SaldoDeGarrafaEnCamion;
}): {
  renglones: RenglonDeCierre[];
  figuras: Map<string, MovidoDelCamion>;
} {
  const renglones: RenglonDeCierre[] = [];
  const figuras = new Map<string, MovidoDelCamion>();
  for (const item of args.items) {
    const m = args.movidos.get(item.gasCylinderId);
    const deliveredFull = m?.deliveredFull ?? 0;
    const collectedEmpty = m?.collectedEmpty ?? 0;
    figuras.set(item.gasCylinderId, { deliveredFull, collectedEmpty });
    const saldo = args.saldoDe(item.gasCylinderId);
    renglones.push({
      gasCylinderId: item.gasCylinderId,
      ...esperadoDe({
        loadedFull: item.loadedFull,
        reloadedFull: item.reloadedFull,
        deliveredFull,
        loadedEmpty: item.loadedEmpty,
        collectedEmpty,
      }),
      declaredFull: item.declaredReturnFull ?? 0,
      declaredEmpty: item.declaredReturnEmpty ?? 0,
      balanceFull: saldo.full,
      balanceEmpty: saldo.empty,
      balanceDefective: saldo.defective,
    });
  }
  for (const g of args.sinRenglon) {
    const m = args.movidos.get(g);
    figuras.set(g, {
      deliveredFull: m?.deliveredFull ?? 0,
      collectedEmpty: m?.collectedEmpty ?? 0,
    });
    const saldo = args.saldoDe(g);
    renglones.push({
      gasCylinderId: g,
      expectedFull: 0,
      expectedEmpty: 0,
      declaredFull: 0,
      declaredEmpty: 0,
      balanceFull: saldo.full,
      balanceEmpty: saldo.empty,
      balanceDefective: saldo.defective,
    });
  }
  return { renglones, figuras };
}

export interface PlanDeCierre {
  movimientos: MovimientoDeStock[];
  renglones: Array<{
    gasCylinderId: string;
    differenceFull: number;
    differenceEmpty: number;
  }>;
  hayDiferencia: boolean;
}

/**
 * Lo que mueve el ledger al cerrar la rendición. El camión tiene que quedar en
 * cero (invariante del diseño):
 *  - lo declarado vuelve camión -> depósito (`truck_return`);
 *  - si en el camión hay MÁS de lo declarado, el resto es faltante: sale como
 *    `shrinkage`; si hay MENOS, la falta es un sobrante: entra como
 *    `adjustment` (hallazgo). El ledger netea el camión, que queda en cero.
 * Las defectuosas que haya en el camión vuelven al depósito tal cual, sin
 * declaración ni diferencia (una rotura registrada con un ajuste `damaged`).
 * La diferencia que se muestra es declarado - esperado; los ajustes se calculan
 * contra el saldo real, que coincide con el esperado salvo que alguien haya
 * movido el camión a mano.
 */
export function planDeCierre(
  camion: string,
  deposito: string,
  renglones: RenglonDeCierre[],
): PlanDeCierre {
  const movimientos: MovimientoDeStock[] = [];
  const resumen: PlanDeCierre['renglones'] = [];
  const porCondicion = (
    gasCylinderId: string,
    condition: StockCondition,
    declarado: number,
    saldo: number,
  ) => {
    if (declarado > 0) {
      movimientos.push({
        gasCylinderId,
        quantity: declarado,
        from: { locationId: camion, condition },
        to: { locationId: deposito, condition },
        reason: StockMovementReason.TRUCK_RETURN,
      });
    }
    if (saldo > declarado) {
      movimientos.push({
        gasCylinderId,
        quantity: saldo - declarado,
        from: { locationId: camion, condition },
        to: null,
        reason: StockMovementReason.SHRINKAGE,
      });
    } else if (declarado > saldo) {
      movimientos.push({
        gasCylinderId,
        quantity: declarado - saldo,
        from: null,
        to: { locationId: camion, condition },
        reason: StockMovementReason.ADJUSTMENT,
      });
    }
  };
  for (const r of renglones) {
    porCondicion(
      r.gasCylinderId,
      StockCondition.FULL,
      r.declaredFull,
      r.balanceFull,
    );
    porCondicion(
      r.gasCylinderId,
      StockCondition.EMPTY,
      r.declaredEmpty,
      r.balanceEmpty,
    );
    if ((r.balanceDefective ?? 0) > 0) {
      movimientos.push({
        gasCylinderId: r.gasCylinderId,
        quantity: r.balanceDefective!,
        from: { locationId: camion, condition: StockCondition.DEFECTIVE },
        to: { locationId: deposito, condition: StockCondition.DEFECTIVE },
        reason: StockMovementReason.TRUCK_RETURN,
      });
    }
    resumen.push({
      gasCylinderId: r.gasCylinderId,
      differenceFull: diferenciaDe(r.declaredFull, r.expectedFull),
      differenceEmpty: diferenciaDe(r.declaredEmpty, r.expectedEmpty),
    });
  }
  // Un ajuste del libro (merma o sobrante) también es una diferencia, aunque la
  // cifra esperada coincida: el camión tenía otra cosa que lo declarado.
  const hayAjuste = movimientos.some(
    (m) =>
      m.reason === StockMovementReason.SHRINKAGE ||
      m.reason === StockMovementReason.ADJUSTMENT,
  );
  return {
    movimientos,
    renglones: resumen,
    hayDiferencia:
      hayAjuste ||
      resumen.some((r) => r.differenceFull !== 0 || r.differenceEmpty !== 0),
  };
}

/** Estado final de la rendición según haya diferencia o no. */
export function estadoDeCierre(hayDiferencia: boolean): TruckLoadStatus {
  return hayDiferencia
    ? TruckLoadStatus.CLOSED_WITH_DIFFERENCE
    : TruckLoadStatus.CLOSED;
}

/** La carga abierta de un chofer, lo que el despacho necesita saber de ella. */
export interface CargaDelChofer {
  number: number;
  status: TruckLoadStatus;
  carId: string;
}

export type MotivoSinPedidos =
  | { codigo: 'sin-carga' }
  | { codigo: 'sin-salir'; number: number }
  | { codigo: 'devuelta'; number: number }
  | { codigo: 'otro-vehiculo'; number: number };

/**
 * Por qué un chofer no recibe ni acepta pedidos (`null`: puede):
 *  - con carga abierta, SÓLO recibe en ruta: en `loading` todavía no salió el
 *    stock y en `returned` ya declaró la vuelta (lo que entregue después sería
 *    stock fantasma en la rendición), tenga o no la distribuidora el control D5;
 *  - en ruta, su vehículo en uso tiene que ser el camión de la carga;
 *  - sin carga, sólo se le niega si la distribuidora exige tenerla (D5).
 */
export function motivoSinPedidos(args: {
  exige: boolean;
  carga: CargaDelChofer | null;
  vehiculoEnUsoId: string | null;
}): MotivoSinPedidos | null {
  const { carga } = args;
  if (!carga) return args.exige ? { codigo: 'sin-carga' } : null;
  if (carga.status === TruckLoadStatus.LOADING) {
    return { codigo: 'sin-salir', number: carga.number };
  }
  if (carga.status === TruckLoadStatus.RETURNED) {
    return { codigo: 'devuelta', number: carga.number };
  }
  if (args.vehiculoEnUsoId !== carga.carId) {
    return { codigo: 'otro-vehiculo', number: carga.number };
  }
  return null;
}
