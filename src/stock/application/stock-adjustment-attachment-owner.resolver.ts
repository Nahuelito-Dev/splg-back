import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { StockAdjustment } from '../entities/stock-adjustment.entity';

/**
 * Dueño `stock_adjustment` de los adjuntos: fotos o actas que respaldan un
 * ajuste de stock (`/attachments/stock_adjustment/:adjustmentId`). Un chofer
 * no accede: sin `isOwnedByUser`, el servicio de adjuntos le responde 403.
 */
@Injectable()
export class StockAdjustmentAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.STOCK_ADJUSTMENT;

  constructor(
    @InjectRepository(StockAdjustment)
    private readonly adjustments: Repository<StockAdjustment>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.adjustments.exists({
      where: { adjustmentId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Ajuste de stock no encontrado');
    }
  }
}
