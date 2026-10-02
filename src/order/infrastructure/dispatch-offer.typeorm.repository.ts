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

  async findOfferedDriverIds(orderId: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { orderId },
      select: { driverId: true },
    });
    return rows.map((r) => r.driverId);
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

  async closeAllActiveOffers(
    orderId: string,
    status: DispatchOfferStatus,
  ): Promise<number> {
    const result = await this.repo.update(
      { orderId, status: DispatchOfferStatus.OFFERED },
      { status },
    );
    return result.affected ?? 0;
  }
}
