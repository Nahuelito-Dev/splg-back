import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';

/**
 * Dueño `purchase_receipt` de los adjuntos: la foto o el PDF del remito del
 * proveedor (`/attachments/purchase_receipt/:receiptId`). Un chofer no accede:
 * sin `isOwnedByUser`, el servicio de adjuntos le responde 403.
 */
@Injectable()
export class PurchaseReceiptAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.PURCHASE_RECEIPT;

  constructor(
    @InjectRepository(PurchaseReceipt)
    private readonly receipts: Repository<PurchaseReceipt>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.receipts.exists({
      where: { receiptId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Recepción de compra no encontrada');
    }
  }
}
