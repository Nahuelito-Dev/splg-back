import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import type { ZonaParaRecargo } from '../../coverage-zone/coverage-zone-pricing.service';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';

/** Mensaje del 409 al cliente cuando ya hay chofer (o el pedido avanzó). */
export const PEDIDO_TOMADO_POR_REPARTIDOR =
  'El pedido ya fue tomado por un repartidor: no se puede modificar';

export const MENSAJE_SENA_PAGADA =
  'El total no puede quedar por debajo de la seña ya pagada';

export const MENSAJE_NO_PASAR_A_MERCADOPAGO =
  'No se puede pasar un pedido a MercadoPago al editarlo: cancelalo y creá uno nuevo';

/** Por qué un pedido no se edita; `null` si se puede editar. */
export type NoEditable = {
  motivo: 'ESTADO' | 'PAGO_ONLINE';
  mensaje: string;
};

type PedidoParaEditar = Pick<
  Order,
  'status' | 'deliveryId' | 'paymentMethod' | 'paymentStatus'
>;

/**
 * Regla única de "¿se puede editar este pedido?": pendiente, sin chofer y sin
 * pago online en curso o cobrado. La usan `UpdateOrderUseCase` (para rechazar
 * con 409) y el DTO de salida (`editable`).
 */
export function motivoNoEditable(order: PedidoParaEditar): NoEditable | null {
  if (order.status !== OrderStatus.PENDING || order.deliveryId) {
    return {
      motivo: 'ESTADO',
      mensaje: `Sólo se edita un pedido pendiente sin chofer asignado (estado actual: ${order.status})`,
    };
  }
  if (
    order.paymentMethod === PaymentMethod.MERCADOPAGO ||
    order.paymentStatus !== PaymentStatus.PENDING
  ) {
    return {
      motivo: 'PAGO_ONLINE',
      mensaje:
        'El pedido tiene un pago online en curso o ya cobrado: no se edita',
    };
  }
  return null;
}

export function esEditable(order: PedidoParaEditar): boolean {
  return motivoNoEditable(order) === null;
}

/**
 * Texto del 409 de una edición (o de su cotización): para el cliente, si el
 * pedido ya lo tomó un repartidor, el mensaje propio; si no, el de la regla.
 */
export function mensajeDeNoEditable(
  order: PedidoParaEditar,
  noEditable: NoEditable,
  esCliente: boolean,
): string {
  const tomado =
    noEditable.motivo === 'ESTADO' &&
    (Boolean(order.deliveryId) ||
      [
        OrderStatus.ACCEPTED,
        OrderStatus.ON_THE_WAY,
        OrderStatus.DELIVERED,
      ].includes(order.status));
  return esCliente && tomado
    ? PEDIDO_TOMADO_POR_REPARTIDOR
    : noEditable.mensaje;
}

/**
 * La zona que el pedido ya tenía (snapshot), para recalcular su recargo. Un
 * pedido sin snapshot pero con recargo guardado conserva ese monto como fijo.
 */
export function zonaGuardada(
  order: Pick<
    Order,
    'zoneSurchargeType' | 'zoneSurchargeValue' | 'zoneSurchargeAmount'
  >,
): ZonaParaRecargo | null {
  if (order.zoneSurchargeType && order.zoneSurchargeValue !== null) {
    return { type: order.zoneSurchargeType, value: order.zoneSurchargeValue };
  }
  if (order.zoneSurchargeAmount > 0) {
    return {
      type: CoverageZoneSurchargeType.FIXED,
      value: order.zoneSurchargeAmount,
    };
  }
  return null;
}

/** Franja y fecha que quedarían al editar, y qué cambió respecto del pedido. */
export interface AgendaDeEdicion {
  timeSlotId: string | null;
  scheduledDate: string | null;
  cambiaFranja: boolean;
  cambiaAgenda: boolean;
}

/**
 * Franja y fecha resultantes de una edición. `timeSlotId: null` saca la
 * franja; sin `scheduledDate` en el cuerpo se conserva la del pedido (no se le
 * inventa una). Lo comparten el PATCH y la cotización de edición: lo que se
 * cotiza bien se puede guardar.
 */
export function agendaDeEdicion(
  order: Pick<Order, 'timeSlotId' | 'scheduledDate'>,
  dto: { timeSlotId?: string | null; scheduledDate?: string },
): AgendaDeEdicion {
  const timeSlotId =
    dto.timeSlotId !== undefined ? dto.timeSlotId : order.timeSlotId;
  const scheduledDate = dto.scheduledDate ?? order.scheduledDate ?? null;
  return {
    timeSlotId,
    scheduledDate,
    cambiaFranja: timeSlotId !== order.timeSlotId,
    cambiaAgenda:
      timeSlotId !== order.timeSlotId ||
      scheduledDate !== (order.scheduledDate ?? null),
  };
}
