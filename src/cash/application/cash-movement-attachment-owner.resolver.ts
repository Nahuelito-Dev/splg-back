import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { CashMovement } from '../entities/cash-movement.entity';

/**
 * Dueño `cash_movement` de los adjuntos (el comprobante de un movimiento de
 * caja). Un chofer no accede: sin `isOwnedByUser`, el servicio de adjuntos le
 * responde 403.
 */
@Injectable()
export class CashMovementAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.CASH_MOVEMENT;

  constructor(
    @InjectRepository(CashMovement)
    private readonly movements: Repository<CashMovement>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.movements.exists({
      where: { movementId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Movimiento de caja no encontrado');
    }
  }
}
