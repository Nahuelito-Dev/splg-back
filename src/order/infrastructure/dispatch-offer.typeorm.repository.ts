import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { DispatchOfferRepositoryPort } from '../domain/ports/dispatch-offer.repository.port';
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
  ): Promise<DispatchOffer> {
    const offer = this.repo.create({
      order_id: orderId,
      driver_id: driverId,
      expiresAt,
      status: DispatchOfferStatus.OFFERED,
    });
    return this.repo.save(offer);
  }

  async findOfferedDriverIds(orderId: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { order_id: orderId },
      select: { driver_id: true },
    });
    return rows.map((r) => r.driver_id);
  }

  async hasActiveOffer(orderId: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { order_id: orderId, status: DispatchOfferStatus.OFFERED },
    });
    return count > 0;
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
    await this.repo.update({ offer_id: offerId }, { status });
  }

  async closeActiveOffer(
    orderId: string,
    driverId: string,
    status: DispatchOfferStatus,
  ): Promise<boolean> {
    const result = await this.repo.update(
      { order_id: orderId, driver_id: driverId, status: DispatchOfferStatus.OFFERED },
      { status },
    );
    return (result.affected ?? 0) > 0;
  }
}
