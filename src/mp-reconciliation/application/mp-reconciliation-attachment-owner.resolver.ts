import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { MpReconciliation } from '../entities/mp-reconciliation.entity';

/**
 * Dueño `mp_reconciliation` de los adjuntos: el reporte de liberaciones de la
 * corrida. Un chofer no accede (sin `isOwnedByUser`, el servicio le responde 403).
 */
@Injectable()
export class MpReconciliationAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.MP_RECONCILIATION;

  constructor(
    @InjectRepository(MpReconciliation)
    private readonly corridas: Repository<MpReconciliation>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.corridas.exists({
      where: { reconciliationId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException(`Conciliación ${ownerId} no encontrada`);
    }
  }
}
