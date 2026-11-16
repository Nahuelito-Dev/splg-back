/**
 * Reglas de la planificación y la edición de las hojas de ruta (E3). Funciones
 * puras: no leen la base ni el reloj (el instante entra por parámetro). Los
 * servicios de `application/` las aplican dentro del cerrojo de la hoja.
 */
import { RouteBatchStatus } from './route-batch.enums';

const MS_POR_MINUTO = 60_000;
const MS_POR_DIA = 24 * 60 * MS_POR_MINUTO;
/** Argentina no tiene horario de verano: UTC−3 todo el año. */
const DESFASE_ARGENTINA_MS = 3 * 60 * MS_POR_MINUTO;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` válido del calendario (rechaza 2026-02-30). */
export function esFechaDelCalendario(fecha: string): boolean {
  if (!FECHA.test(fecha)) return false;
  const d = new Date(`${fecha}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha;
}

/** Medianoche argentina del día, como instante. */
export function inicioDelDia(fecha: string): number {
  return Date.parse(`${fecha}T00:00:00Z`) + DESFASE_ARGENTINA_MS;
}

/** Un horario `HH:MM[:SS]` del día argentino, como instante. */
export function instanteDelDia(fecha: string, hora: string): number {
  const [h, m, s] = hora.split(':').map(Number);
  return inicioDelDia(fecha) + ((h * 60 + m) * 60 + (s || 0)) * 1000;
}

/**
 * Cierre de la planificación del día `fecha`: el día ANTERIOR a la hora del
 * parámetro (por omisión, 18:00 de D−1). Es cuando el cron arma la propuesta.
 */
export function cierreDeLaPlanificacion(
  fecha: string,
  hora: number,
  minuto: number,
): Date {
  return new Date(
    inicioDelDia(fecha) - MS_POR_DIA + (hora * 60 + minuto) * MS_POR_MINUTO,
  );
}

/** El día argentino siguiente a `fecha`. */
export function diaSiguiente(fecha: string): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + MS_POR_DIA)
    .toISOString()
    .slice(0, 10);
}

/** Hora de salida por omisión: media hora antes de la primera franja, nunca después de las 8. */
export function salidaPorOmision(
  fecha: string,
  iniciosDeFranja: readonly number[],
): number {
  const ocho = instanteDelDia(fecha, '08:00');
  if (iniciosDeFranja.length === 0) return ocho;
  return Math.min(ocho, Math.min(...iniciosDeFranja) - 30 * MS_POR_MINUTO);
}

/** La hoja todavía se arma: se le pueden mover, sumar y sacar paradas. */
export function esEditable(status: RouteBatchStatus): boolean {
  return status === RouteBatchStatus.DRAFT;
}

/** Se puede cancelar: todavía no la inició el chofer. */
export function esCancelable(status: RouteBatchStatus): boolean {
  return (
    status === RouteBatchStatus.DRAFT || status === RouteBatchStatus.CONFIRMED
  );
}

/** La versión que vio quien edita sigue siendo la vigente. */
export function versionVigente(actual: number, enviada: number): boolean {
  return actual === enviada;
}

/**
 * El orden manual trae exactamente las paradas activas: ni una de más, ni una
 * de menos, ni repetidas.
 */
export function esPermutacionDe(
  activas: readonly string[],
  propuesta: readonly string[],
): boolean {
  if (activas.length !== propuesta.length) return false;
  // Con el mismo largo, una repetida deja afuera a alguna activa: la cubre el `every`.
  const vistas = new Set(propuesta);
  return activas.every((id) => vistas.has(id));
}

/** Por qué no se puede confirmar una hoja. */
export type RouteSheetViolationCode =
  | 'driver_missing'
  | 'car_missing'
  | 'no_stops'
  | 'driver_unavailable'
  | 'car_unavailable'
  | 'driver_taken'
  | 'car_taken'
  | 'capacity_kg'
  | 'capacity_units'
  | 'late_stops'
  | 'stops_not_plannable';

export interface RouteSheetViolation {
  code: RouteSheetViolationCode;
  message: string;
  /** Pedidos involucrados (las paradas fuera de franja o que ya no se pueden planificar). */
  orderIds?: string[];
}

export interface ConfirmacionInput {
  deliveryId: string | null;
  carId: string | null;
  stopCount: number;
  /** El chofer está deshabilitado, sin validar o inhabilitado por flota/legajo. */
  driverUnavailable: boolean;
  /** El vehículo está dado de baja o fuera de servicio. */
  carUnavailable: boolean;
  /** El chofer ya tiene otra hoja confirmada o en curso ese día. */
  driverTaken: boolean;
  carTaken: boolean;
  peakKg: number;
  peakUnits: number;
  capacityKg: number | null;
  capacityUnits: number | null;
  /** Paradas que llegarían después de que cierra su franja. */
  lateOrderIds: readonly string[];
  /** El administrador confirma igual con paradas fuera de franja. */
  acceptLateStops: boolean;
  /**
   * Paradas cuyo pedido ya no se puede planificar (se canceló, se entregó, se
   * le asignó chofer, cambió de día…). No se aceptan: hay que sacarlas.
   */
  unplannableOrderIds?: readonly string[];
}

/**
 * Lo que impide confirmar (§5 del diseño): chofer y vehículo, al menos una
 * parada, los dos disponibles y sin otra hoja ese día, el pico de carga dentro
 * de la capacidad (si está cargada) y todas las paradas en franja salvo que el
 * administrador las acepte. Vacío: se puede confirmar.
 */
export function violacionesParaConfirmar(
  i: ConfirmacionInput,
): RouteSheetViolation[] {
  const v: RouteSheetViolation[] = [];
  if (!i.deliveryId) {
    v.push({ code: 'driver_missing', message: 'La hoja no tiene chofer' });
  }
  if (!i.carId) {
    v.push({ code: 'car_missing', message: 'La hoja no tiene vehículo' });
  }
  if (i.stopCount < 1) {
    v.push({ code: 'no_stops', message: 'La hoja no tiene paradas' });
  }
  if (i.deliveryId && i.driverUnavailable) {
    v.push({
      code: 'driver_unavailable',
      message: 'El chofer no está habilitado para repartir',
    });
  }
  if (i.carId && i.carUnavailable) {
    v.push({
      code: 'car_unavailable',
      message: 'El vehículo está dado de baja o fuera de servicio',
    });
  }
  if (i.deliveryId && i.driverTaken) {
    v.push({
      code: 'driver_taken',
      message: 'El chofer ya tiene otra hoja confirmada ese día',
    });
  }
  if (i.carId && i.carTaken) {
    v.push({
      code: 'car_taken',
      message: 'El vehículo ya tiene otra hoja confirmada ese día',
    });
  }
  if (i.capacityKg !== null && i.peakKg > i.capacityKg) {
    v.push({
      code: 'capacity_kg',
      message: `La carga llega a ${i.peakKg} kg y el vehículo admite ${i.capacityKg} kg`,
    });
  }
  if (i.capacityUnits !== null && i.peakUnits > i.capacityUnits) {
    v.push({
      code: 'capacity_units',
      message: `La carga llega a ${i.peakUnits} garrafas y el vehículo admite ${i.capacityUnits}`,
    });
  }
  if (i.lateOrderIds.length > 0 && !i.acceptLateStops) {
    v.push({
      code: 'late_stops',
      message:
        i.lateOrderIds.length === 1
          ? 'Una parada llega fuera de su franja: confirmá aceptándola o cambiá el orden'
          : `${i.lateOrderIds.length} paradas llegan fuera de su franja: confirmá aceptándolas o cambiá el orden`,
      orderIds: [...i.lateOrderIds],
    });
  }
  const invalidas = i.unplannableOrderIds ?? [];
  if (invalidas.length > 0) {
    v.push({
      code: 'stops_not_plannable',
      message:
        invalidas.length === 1
          ? 'Una parada tiene un pedido que ya no se puede repartir en la hoja (cancelado, entregado o con otro chofer): sacala de la hoja'
          : `${invalidas.length} paradas tienen pedidos que ya no se pueden repartir en la hoja (cancelados, entregados o con otro chofer): sacalas de la hoja`,
      orderIds: [...invalidas],
    });
  }
  return v;
}

/** Lo que hace falta de un pedido para decidir si entra en una hoja de ese día. */
export interface PedidoParaPlanificar {
  status: string;
  deliveryId: string | null;
  scheduledDate: string | null;
  hasSlot: boolean;
  deliveryMode: string;
  depositPaid: boolean;
  fraudHold: boolean;
  hasPoint: boolean;
}

/**
 * Por qué un pedido no entra en una hoja del día `fecha` (§7.1), o `null` si
 * entra: programado para ese día con franja, reparto común, sin chofer,
 * pendiente (o reservado con la seña paga), sin retención por el pago y con
 * punto de entrega.
 */
export function motivoNoPlanificable(
  p: PedidoParaPlanificar,
  fecha: string,
): string | null {
  if (p.scheduledDate !== fecha) return 'está programado para otro día';
  if (!p.hasSlot) return 'no tiene franja horaria';
  if (p.deliveryMode !== 'standard') return 'es un pedido express';
  if (p.deliveryId !== null) return 'ya tiene chofer';
  const pendiente =
    p.status === 'pending' || (p.status === 'reserved' && p.depositPaid);
  if (!pendiente) return 'no está pendiente de entrega';
  if (p.fraudHold) return 'está retenido por la revisión del pago';
  if (!p.hasPoint) return 'no tiene punto de entrega';
  return null;
}

/**
 * Paradas de la hoja cuyo pedido ya no entra (se canceló, se entregó, tiene
 * chofer, cambió de día…) o que ya no se ve (otra distribuidora o borrado).
 */
export function paradasNoPlanificables(
  orden: readonly string[],
  pedidos: ReadonlyArray<PedidoParaPlanificar & { orderId: string }>,
  fecha: string,
): string[] {
  const porId = new Map(pedidos.map((p) => [p.orderId, p]));
  return orden.filter((id) => {
    const p = porId.get(id);
    return !p || motivoNoPlanificable(p, fecha) !== null;
  });
}
