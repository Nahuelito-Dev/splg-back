import Decimal from 'decimal.js';
import { OrderMapper } from '../order/order.mapper';
import type { Order } from '../order/entities/order.entity';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
} from './entities/repurchase-invitation.entity';
import { DetalleDeInvitacion } from './repurchase-invitation-detail.service';
import { diasHasta } from './domain/estimacion-de-recompra';
import type {
  AvisoDeRecompra,
  MiRecompra,
} from './repurchase-customer.service';
import { RecompraEstimada } from './repurchase-estimator.service';
import type { ResultadoDeCorrida } from './repurchase-forecast.service';
import type { ResumenDeInvitaciones } from './repurchase-invitation.service';
import {
  AcceptInvitationResponseDto,
  AdminInvitationResponseDto,
  InvitationItemDto,
  MyRepurchaseResponseDto,
  RepurchaseForecastRowDto,
  RepurchaseInvitationResponseDto,
  RepurchaseNoticeResponseDto,
  RepurchaseRunResponseDto,
  RepurchaseStatsResponseDto,
} from './dto/repurchase-response.dto';

function unidades(invitacion: RepurchaseInvitation): number {
  return invitacion.suggestedItems.reduce((n, i) => n + i.quantity, 0);
}

function redondear(valor: number, decimales = 1): number {
  return new Decimal(valor)
    .toDecimalPlaces(decimales, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export class RepurchaseMapper {
  /** La invitación del cliente, con el pedido precargado a precios de hoy. */
  static invitation(
    invitacion: RepurchaseInvitation,
    detalle: DetalleDeInvitacion,
  ): RepurchaseInvitationResponseDto {
    const items: InvitationItemDto[] = invitacion.suggestedItems.map((i) => {
      const garrafa = detalle.garrafas.get(i.gasCylinderId);
      const precio = garrafa?.price ?? 0;
      return {
        gasCylinderId: i.gasCylinderId,
        type: garrafa?.type ?? 'Producto no disponible',
        quantity: i.quantity,
        unitPrice: precio,
        subtotal: new Decimal(precio).times(i.quantity).toNumber(),
        available: Boolean(garrafa?.isActive && garrafa.stock >= i.quantity),
      };
    });
    const { direccion, franja } = detalle;
    return {
      invitationId: invitacion.invitationId,
      distributorId: invitacion.distributorId,
      status: invitacion.status,
      projectedDepletionAt: invitacion.projectedDepletionAt,
      estimateSource: invitacion.estimateSource,
      items,
      estimatedTotal: items
        .reduce((suma, i) => suma.plus(i.subtotal), new Decimal(0))
        .toNumber(),
      address: direccion
        ? {
            addressId: direccion.addressId,
            label:
              direccion.formattedAddress ??
              `${direccion.street}, ${direccion.city}`,
          }
        : null,
      timeSlot: franja
        ? {
            timeSlotId: franja.timeSlotId,
            name: franja.name,
            startTime: franja.startTime.slice(0, 5),
            endTime: franja.endTime.slice(0, 5),
          }
        : null,
      paymentMethod: invitacion.paymentMethod,
      expiresAt: invitacion.expiresAt,
      createdAt: invitacion.createdAt,
      respondedAt: invitacion.respondedAt,
      orderId: invitacion.orderId,
    };
  }

  static accepted(
    invitation: RepurchaseInvitationResponseDto,
    order: Order,
    paymentUrl?: string,
  ): AcceptInvitationResponseDto {
    const dto = OrderMapper.toDto(order);
    dto.paymentUrl = paymentUrl;
    return { invitation, order: dto };
  }

  static adminInvitation(
    invitacion: RepurchaseInvitation,
  ): AdminInvitationResponseDto {
    return {
      invitationId: invitacion.invitationId,
      status: invitacion.status,
      customer: {
        customerId: invitacion.user?.customer?.customerId ?? null,
        userId: invitacion.userId,
        fullName: invitacion.user?.fullName ?? null,
        email: invitacion.user?.email ?? null,
        phoneNumber: invitacion.user?.phoneNumber ?? null,
      },
      projectedDepletionAt: invitacion.projectedDepletionAt,
      estimateSource: invitacion.estimateSource,
      totalUnits: unidades(invitacion),
      expiresAt: invitacion.expiresAt,
      createdAt: invitacion.createdAt,
      respondedAt: invitacion.respondedAt,
      orderId: invitacion.orderId,
    };
  }

  static stats(
    resumen: ResumenDeInvitaciones,
    desde: Date,
    hasta: Date,
  ): RepurchaseStatsResponseDto {
    const c = resumen.counts;
    const resueltas =
      c[RepurchaseInvitationStatus.ACCEPTED] +
      c[RepurchaseInvitationStatus.REJECTED] +
      c[RepurchaseInvitationStatus.EXPIRED];
    return {
      from: desde,
      to: hasta,
      sent: Object.values(c).reduce((a, n) => a + n, 0),
      pending: c[RepurchaseInvitationStatus.PENDING],
      accepted: c[RepurchaseInvitationStatus.ACCEPTED],
      rejected: c[RepurchaseInvitationStatus.REJECTED],
      expired: c[RepurchaseInvitationStatus.EXPIRED],
      cancelled: c[RepurchaseInvitationStatus.CANCELLED],
      conversionRate:
        resueltas === 0
          ? null
          : new Decimal(c[RepurchaseInvitationStatus.ACCEPTED])
              .div(resueltas)
              .toDecimalPlaces(4)
              .toNumber(),
      acceptedRevenue: resumen.acceptedRevenue,
    };
  }

  static forecastRow(
    cliente: RecompraEstimada,
    ahora: Date,
    abierta: RepurchaseInvitation | null,
  ): RepurchaseForecastRowDto {
    const e = cliente.estimate;
    return {
      customer: {
        customerId: cliente.customerId,
        userId: cliente.userId,
        fullName: cliente.fullName,
        email: cliente.email,
        phoneNumber: cliente.phoneNumber,
      },
      estimatedAt: e.estimatedAt,
      daysLeft: redondear(diasHasta(e.estimatedAt, ahora)),
      source: e.source,
      ordersUsed: e.ordersUsed,
      lastPurchaseAt: e.lastDeliveredAt,
      lastPurchaseKg: redondear(e.lastKg, 2),
      declaredKgPerMonth: cliente.declaredKgPerMonth,
      estimatedKgPerMonth: redondear(e.kgPerDay * 30, 2),
      usualUnits: cliente.habits.items.reduce((n, i) => n + i.quantity, 0),
      usualCylinderIds: cliente.habits.items.map((i) => i.gasCylinderId),
      noticeEnabled: cliente.noticeEnabled,
      noticeDays: cliente.noticeDays,
      openInvitation: abierta
        ? {
            invitationId: abierta.invitationId,
            expiresAt: abierta.expiresAt,
          }
        : null,
    };
  }

  static notice(aviso: AvisoDeRecompra): RepurchaseNoticeResponseDto {
    return {
      enabled: aviso.enabled,
      days: aviso.days,
      distributorDays: aviso.distributorDays,
      effectiveDays: aviso.days ?? aviso.distributorDays,
    };
  }

  /** La fecha estimada del propio cliente. */
  static mine(mia: MiRecompra, ahora: Date): MyRepurchaseResponseDto {
    const e = mia.estimacion?.estimate ?? null;
    return {
      estimatedAt: e?.estimatedAt ?? null,
      daysLeft: e ? redondear(diasHasta(e.estimatedAt, ahora)) : null,
      source: e?.source ?? null,
      reason: mia.reason,
      notice: RepurchaseMapper.notice(mia.aviso),
      openInvitation: mia.abierta
        ? RepurchaseMapper.invitation(
            mia.abierta.invitacion,
            mia.abierta.detalle,
          )
        : null,
    };
  }

  static run(r: ResultadoDeCorrida): RepurchaseRunResponseDto {
    return {
      evaluated: r.evaluated,
      invited: r.invited,
      expired: r.expired,
      skipped: { ...r.skipped },
      candidates: r.candidates.map((c) => ({
        userId: c.userId,
        fullName: c.fullName,
        projectedDepletionAt: c.projectedDepletionAt,
        source: c.source,
        totalUnits: c.items.reduce((n, i) => n + i.quantity, 0),
      })),
    };
  }
}
