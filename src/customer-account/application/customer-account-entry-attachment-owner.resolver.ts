import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { CustomerAccountEntry } from '../entities/customer-account-entry.entity';

/**
 * Dueño `customer_account_entry` de los adjuntos (el comprobante de un pago o
 * ajuste de cuenta corriente). Un chofer no accede.
 */
@Injectable()
export class CustomerAccountEntryAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.CUSTOMER_ACCOUNT_ENTRY;

  constructor(
    @InjectRepository(CustomerAccountEntry)
    private readonly entries: Repository<CustomerAccountEntry>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.entries.exists({
      where: { entryId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException(
        `Asiento de cuenta corriente ${ownerId} no encontrado`,
      );
    }
  }
}
