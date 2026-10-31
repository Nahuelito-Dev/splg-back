import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, LessThan, Not, Repository } from 'typeorm';
import { ESTADO_ABIERTO } from '../domain/dispatch-offer-status.machine';
import { Order } from '../entities/order.entity';
import {
  DispatchOfferRepositoryPort,
  DriverOfferState,
} from '../domain/ports/dispatch-offer.repository.port';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../entities/dispatch-offer.entity';

/** ADAPTER TypeORM del DispatchOfferRepositoryPort. */
@Injectable()
export class DispatchOfferTypeormRepository extends DispatchOfferRepositoryPort {
  constructor(
    @InjectRepository(DispatchOffer)
    private readonly repo: Repository<DispatchOffer>,
  ) {
    super();
  }

  create(
    orderId: string,
    driverId: string,
    expiresAt: Date,
    distributorId?: string | null,
  ): Promise<DispatchOffer> {
    const offer = this.repo.create({
      orderId,
      driverId,
      distributorId: distributorId ?? undefined,
      expiresAt,
      status: ESTADO_ABIERTO,
    });
    return this.repo.save(offer);
  }

  async findDriverOfferState(
    orderId: string,
    now: Date,
    cooldownMs: number,
    maxReofertas: number,
  ): Promise<DriverOfferState> {
    const rows = await this.repo.find({
      where: { orderId },
      select: { driverId: true, status: true, expiresAt: true },
    });
    const cooldownHasta = now.getTime() - cooldownMs;
    const blocked = new Set<string>();
    const contactados = new Set<string>();
    const vencidasPorChofer = new Map<string, number>();
    for (const row of rows) {
      // Una oferta retirada por una edición del pedido no es un intento.
      if (row.status === DispatchOfferStatus.SUPERSEDED) continue;
      contactados.add(row.driverId);
      if (row.status === DispatchOfferStatus.EXPIRED) {
        vencidasPorChofer.set(
          row.driverId,
          (vencidasPorChofer.get(row.driverId) ?? 0) + 1,
        );
      }
      const venciaHaceMucho =
        row.status === DispatchOfferStatus.EXPIRED &&
        row.expiresAt.getTime() <= cooldownHasta;
      if (!venciaHaceMucho) blocked.add(row.driverId);
    }
    for (const [driverId, vencidas] of vencidasPorChofer) {
      if (vencidas >= maxReofertas) blocked.add(driverId);
    }
    return {
      blocked: [...blocked],
      reofferable: [...contactados].filter((id) => !blocked.has(id)),
    };
  }

  async hasActiveOffer(orderId: string, driverId?: string): Promise<boolean> {
    const count = await this.repo.count({
      where: {
        orderId,
        status: ESTADO_ABIERTO,
        ...(driverId ? { driverId } : {}),
      },
    });
    return count > 0;
  }

  async isInLiveBatch(orderId: string): Promise<boolean> {
    const filas: unknown[] = await this.repo.query(
      `SELECT 1 FROM "route_batch_stop" s
         JOIN "route_batch" b ON b."batch_id" = s."batch_id"
        WHERE s."order_id" = $1 AND s."active" AND b."status" IN ('forming', 'offered')
        LIMIT 1`,
      [orderId],
    );
    return filas.length > 0;
  }

  async isHeldForBatching(orderId: string): Promise<boolean> {
    const filas: unknown[] = await this.repo.query(
      `SELECT 1 FROM "order" o
         JOIN "time_slot" ts ON ts."time_slot_id" = o."time_slot_id"
         JOIN "module_config" mc ON mc."distributor_id" = o."distributor_id"
                                AND mc."module" = 'route_batching'
        WHERE o."order_id" = $1
          AND o."delivery_mode" = 'standard'
          AND o."scheduled_date" IS NOT NULL
          AND COALESCE((mc."params" ->> 'enabled')::numeric, 0) = 1
          AND COALESCE((mc."params" ->> 'batchingHoldMinutes')::numeric, 60) > 0
          AND now() < ((o."scheduled_date" + ts."startTime") AT TIME ZONE 'America/Argentina/Buenos_Aires')
                      - make_interval(mins => COALESCE((mc."params" ->> 'batchingHoldMinutes')::numeric, 60)::int)
        LIMIT 1`,
      [orderId],
    );
    return filas.length > 0;
  }

  async hasHeldOrder(orderId: string, driverId: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { orderId, driverId, status: DispatchOfferStatus.ACCEPTED },
    });
    return count > 0;
  }

  async recordDriverHeldOrder(
    orderId: string,
    driverId: string,
  ): Promise<void> {
    // Un pedido tiene un solo chofer que lo sostiene (`UQ_order_dispatch_offer_
    // aceptada`): si otro lo tenía y el pedido pasó a éste, esa constancia se
    // cierra como rechazada (el chofer anterior lo soltó y no se le reofrece).
    await this.repo.update(
      {
        orderId,
        status: DispatchOfferStatus.ACCEPTED,
        driverId: Not(driverId),
      },
      { status: DispatchOfferStatus.REJECTED },
    );
    const cerradas = await this.closeActiveOffer(
      orderId,
      driverId,
      DispatchOfferStatus.ACCEPTED,
    );
    if (cerradas) return;
    const yaConstancia = await this.repo.count({
      where: { orderId, driverId, status: DispatchOfferStatus.ACCEPTED },
    });
    if (yaConstancia > 0) return;
    const order = await this.repo.manager.findOne(Order, {
      where: { orderId },
      select: { orderId: true, distributorId: true },
    });
    if (!order) return;
    await this.repo.save(
      this.repo.create({
        orderId,
        driverId,
        distributorId: order.distributorId ?? undefined,
        // La constancia no vence: el margen sólo evita que el reloj de la
        // aplicación quede por detrás del de la base (`expiresAt > offeredAt`).
        expiresAt: new Date(Date.now() + 1000),
        status: DispatchOfferStatus.ACCEPTED,
      }),
    );
  }

  findExpired(now: Date): Promise<DispatchOffer[]> {
    return this.repo.find({
      where: {
        status: ESTADO_ABIERTO,
        expiresAt: LessThan(now),
      },
      relations: ['order'],
    });
  }

  async updateStatus(
    offerId: string,
    status: DispatchOfferStatus,
  ): Promise<boolean> {
    // Sólo desde OFFERED: una oferta ya aceptada, rechazada o reemplazada no se
    // pisa (p. ej. el cron de vencimiento contra un chofer que acaba de aceptar).
    const result = await this.repo.update(
      { offerId, status: ESTADO_ABIERTO },
      { status },
    );
    return (result.affected ?? 0) > 0;
  }

  async closeActiveOffer(
    orderId: string,
    driverId: string,
    status: DispatchOfferStatus,
  ): Promise<boolean> {
    const result = await this.repo.update(
      {
        orderId,
        driverId,
        status: ESTADO_ABIERTO,
      },
      { status },
    );
    return (result.affected ?? 0) > 0;
  }

  async withdrawOtherActiveOffers(
    manager: EntityManager,
    orderId: string,
    exceptDriverId: string | null,
    status: DispatchOfferStatus,
  ): Promise<string[]> {
    const abiertas = await manager.find(DispatchOffer, {
      where: { orderId, status: ESTADO_ABIERTO },
      select: { offerId: true, driverId: true },
    });
    const aRetirar = abiertas.filter((o) => o.driverId !== exceptDriverId);
    if (aRetirar.length === 0) return [];
    await manager.update(
      DispatchOffer,
      { offerId: In(aRetirar.map((o) => o.offerId)) },
      { status },
    );
    return [...new Set(aRetirar.map((o) => o.driverId))];
  }
}
