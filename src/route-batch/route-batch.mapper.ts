import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { coordenadasDePunto } from '../common/geo/punto';
import { RouteBatch } from '../order/entities/route-batch.entity';
import { RouteBatchOffer } from '../order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../order/entities/route-batch-stop.entity';
import {
  DriverRouteBatchResponseDto,
  RouteBatchOfferResponseDto,
  RouteBatchResponseDto,
  RouteBatchStopResponseDto,
} from './dto/route-batch-response.dto';

const iso = (fecha: Date | null | undefined): string | null =>
  fecha ? fecha.toISOString() : null;

/** Nombre de cada chofer por `deliveryId`, para mostrar quién recibió cada oferta. */
export type ChoferesDelLote = Map<
  string,
  { deliveryId: string; userId: string; name: string | null }
>;

export class RouteBatchMapper {
  static parada(stop: RouteBatchStop): RouteBatchStopResponseDto {
    const order = stop.order;
    const punto = coordenadasDePunto(order.deliveryPoint);
    const items = (order.items ?? []).map((i) => ({
      name: i.gasCylinder?.type ?? '',
      quantity: i.quantity,
    }));
    const peso = (order.items ?? []).reduce(
      (acc, i) => acc + i.quantity * Number(i.gasCylinder?.weight ?? 0),
      0,
    );
    return {
      orderId: stop.orderId,
      sequence: stop.sequence,
      active: stop.active,
      etaAt: iso(stop.etaAt),
      legDistanceKm: Number(stop.legDistanceKm),
      weightKg: Math.round(peso * 100) / 100,
      scheduledDate: order.scheduledDate ?? '',
      slot: order.timeSlot
        ? {
            name: order.timeSlot.name,
            startTime: order.timeSlot.startTime,
            endTime: order.timeSlot.endTime,
          }
        : null,
      address: {
        street: order.address?.street ?? '',
        city: order.address?.city ?? '',
        floor: order.address?.floor ?? null,
        apartment: order.address?.apartment ?? null,
        formattedAddress: order.address?.formattedAddress ?? null,
        latitude: punto?.lat ?? null,
        longitude: punto?.lng ?? null,
      },
      customerName: order.customer?.fullName ?? null,
      paymentMethod: order.paymentMethod,
      totalAmount: Number(order.totalAmount),
      orderStatus: order.status,
      items,
    };
  }

  static oferta(
    offer: RouteBatchOffer,
    choferes: ChoferesDelLote,
  ): RouteBatchOfferResponseDto {
    return {
      offerId: offer.offerId,
      deliveryId: offer.deliveryId,
      driverName: choferes.get(offer.deliveryId)?.name ?? null,
      status: offer.status,
      expiresAt: offer.expiresAt.toISOString(),
      respondedAt: iso(offer.respondedAt),
    };
  }

  static lote(
    batch: RouteBatch,
    stops: RouteBatchStop[],
    offers: RouteBatchOffer[],
    choferes: ChoferesDelLote,
  ): RouteBatchResponseDto {
    const ofertas = [...offers]
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .map((o) => RouteBatchMapper.oferta(o, choferes));
    const chofer = batch.deliveryId ? choferes.get(batch.deliveryId) : null;
    return {
      batchId: batch.batchId,
      status: batch.status,
      totalWeightKg: Number(batch.totalWeightKg),
      createdAt: batch.createdAt.toISOString(),
      closedAt: iso(batch.closedAt),
      closeReason: batch.closeReason,
      driver: chofer ?? null,
      currentOffer:
        ofertas.find((o) => o.status === ProposalStatus.PENDING) ?? null,
      offers: ofertas,
      stops: [...stops]
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => RouteBatchMapper.parada(s)),
    };
  }

  /** Lo que ve el chofer: sólo su oferta y las paradas vivas (o las del recorrido que hizo). */
  static loteDelChofer(
    batch: RouteBatch,
    stops: RouteBatchStop[],
    offer: RouteBatchOffer | null,
  ): DriverRouteBatchResponseDto {
    const paradas = [...stops]
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => RouteBatchMapper.parada(s));
    return {
      batchId: batch.batchId,
      status: batch.status,
      totalWeightKg: Number(batch.totalWeightKg),
      stopCount: paradas.filter((p) => p.active).length,
      createdAt: batch.createdAt.toISOString(),
      offer: offer
        ? {
            offerId: offer.offerId,
            status: offer.status,
            expiresAt: offer.expiresAt.toISOString(),
            respondedAt: iso(offer.respondedAt),
          }
        : null,
      stops: paradas,
    };
  }
}
