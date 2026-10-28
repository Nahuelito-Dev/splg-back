import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { DriverSettlement } from '../entities/driver-settlement.entity';

/**
 * Dueño `driver_settlement` de los adjuntos (comprobantes de gastos, ticket del
 * depósito). El chofer accede a sus propias rendiciones.
 */
@Injectable()
export class DriverSettlementAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.DRIVER_SETTLEMENT;

  constructor(
    @InjectRepository(DriverSettlement)
    private readonly settlements: Repository<DriverSettlement>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.settlements.exists({
      where: { settlementId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException(`Rendición ${ownerId} no encontrada`);
    }
  }

  isOwnedByUser(
    ownerId: string,
    userId: string,
    distributorId: string,
  ): Promise<boolean> {
    return this.settlements.exists({
      where: {
        settlementId: ownerId,
        distributorId,
        delivery: { userId },
      },
    });
  }
}
