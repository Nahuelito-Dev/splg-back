import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, LessThan, Repository } from 'typeorm';
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
      status: DispatchOfferStatus.OFFERED,
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
        status: DispatchOfferStatus.OFFERED,
        ...(driverId ? { driverId } : {}),
      },
    });
    return count > 0;
  }

  async recordDriverHeldOrder(
    orderId: string,
    driverId: string,
  ): Promise<void> {
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
        expiresAt: new Date(),
        status: DispatchOfferStatus.ACCEPTED,
      }),
    );
  }

  findExpired(now: Date): Promise<DispatchOffer[]> {
    return this.repo.find({
      where: {
        status: DispatchOfferStatus.OFFERED,
        expiresAt: LessThan(now),
      },
      relations: ['order'],
    });
  }

  async updateStatus(
    offerId: string,
    status: DispatchOfferStatus,
  ): Promise<void> {
    await this.repo.update({ offerId }, { status });
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
        status: DispatchOfferStatus.OFFERED,
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
      where: { orderId, status: DispatchOfferStatus.OFFERED },
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
