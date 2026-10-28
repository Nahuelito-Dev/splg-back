import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { Order } from '../entities/order.entity';

/**
 * Dueño `order` de los adjuntos (el comprobante de la transferencia y lo que el
 * admin agregue al pedido). Un chofer no accede: sin `isOwnedByUser`, el
 * servicio de adjuntos le responde 403. El cliente sube su comprobante por
 * `POST /v2/orders/:id/transfer-receipt`, no por el endpoint genérico.
 */
@Injectable()
export class OrderAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.ORDER;

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.orders.exists({
      where: { orderId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException(`Pedido ${ownerId} no encontrado`);
    }
  }
}
