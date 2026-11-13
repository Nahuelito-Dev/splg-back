import { inicioDelDiaArgentino } from '../../common/utils/dias-argentina';
import { OrderDeliveryMode, OrderStatus } from '../entities/order.entity';
import { esperaPagoOnline, PagoDelPedido } from './espera-pago-online';

/** Motivo con que el sistema cancela un pedido que nadie tomó a tiempo. */
export const MOTIVO_VENCIMIENTO_SIN_CHOFER =
  'No hubo choferes disponibles para tu pedido. Lo cancelamos y, si lo habías pagado, te devolvemos el dinero.';

/** Lo mínimo del pedido que decide si venció esperando chofer. */
export interface PedidoQueEsperaChofer extends PagoDelPedido {
  status: OrderStatus | `${OrderStatus}`;
  deliveryId: string | null;
  deliveryMode: OrderDeliveryMode | `${OrderDeliveryMode}`;
  createdAt: Date;
  /** Desde cuándo se puede ofrecer a los choferes (null: desde que se creó). */
  availableSince: Date | null;
  /** Día agendado `YYYY-MM-DD` (null: inmediato). */
  scheduledDate?: string | null;
  /** Hora de inicio de la franja (`HH:MM` o `HH:MM:SS`), si tiene. */
  inicioDeFranja?: string | null;
}

const FORMATO_HORA = /^(\d{2}):(\d{2})(?::(\d{2}))?/;

function milisegundosDeLaHora(hora: string | null | undefined): number {
  const m = hora ? FORMATO_HORA.exec(hora) : null;
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000;
}

/**
 * Instante en que arranca la agenda del pedido, en hora argentina: el día
 * agendado a la hora de inicio de su franja, o a las 00:00 si no tiene franja.
 * `null` si no está agendado (o el día no es válido).
 */
export function inicioDeLaAgenda(
  pedido: Pick<PedidoQueEsperaChofer, 'scheduledDate' | 'inicioDeFranja'>,
): Date | null {
  if (!pedido.scheduledDate) return null;
  const dia = inicioDelDiaArgentino(pedido.scheduledDate);
  if (!dia) return null;
  return new Date(dia.getTime() + milisegundosDeLaHora(pedido.inicioDeFranja));
}

/**
 * Desde cuándo corre la espera: lo último entre que se pudo ofrecer
 * (`availableSince`, o el alta) y el inicio de su agenda.
 */
export function inicioDeLaEspera(pedido: PedidoQueEsperaChofer): Date {
  const ofrecible = new Date(pedido.availableSince ?? pedido.createdAt);
  const agenda = inicioDeLaAgenda(pedido);
  return agenda && agenda > ofrecible ? agenda : ofrecible;
}

/**
 * ¿El pedido espera un chofer y le corre el reloj? Sólo un pendiente sin
 * chofer, que no espera un pago online ni está retenido por fraude, y que no
 * es express (el express tiene su propia regla: pasa al reparto común).
 */
export function esperaChofer(pedido: PedidoQueEsperaChofer): boolean {
  return (
    pedido.status === OrderStatus.PENDING &&
    !pedido.deliveryId &&
    pedido.deliveryMode !== OrderDeliveryMode.EXPRESS &&
    !esperaPagoOnline(pedido)
  );
}

/** Cuándo vence la espera de chofer; `null` si al pedido no le corre el reloj. */
export function vencimientoSinChofer(
  pedido: PedidoQueEsperaChofer,
  minutos: number,
): Date | null {
  if (!esperaChofer(pedido)) return null;
  return new Date(inicioDeLaEspera(pedido).getTime() + minutos * 60_000);
}

/** ¿Venció la espera de chofer en `ahora`? */
export function vencioSinChofer(
  pedido: PedidoQueEsperaChofer,
  minutos: number,
  ahora: Date,
): boolean {
  const vence = vencimientoSinChofer(pedido, minutos);
  return vence !== null && ahora.getTime() >= vence.getTime();
}

/**
 * Marca el pedido como ofrecible desde `ahora`: lo llaman las transiciones que
 * lo dejan pendiente, sin chofer y en condiciones de salir (alta, pago aprobado,
 * liberación, fin de la retención por fraude, cambio de agenda, reserva activada).
 */
export function marcarOfrecible(
  pedido: { availableSince: Date | null },
  ahora: Date = new Date(),
): void {
  pedido.availableSince = ahora;
}
