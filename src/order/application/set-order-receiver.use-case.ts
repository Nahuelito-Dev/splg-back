import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { SetOrderReceiverDto } from '../dto/set-order-receiver.dto';

export const MENSAJE_RECEPTOR_ENTREGADO =
  'El pedido ya fue entregado: no se puede indicar quién lo recibe';
export const MENSAJE_RECEPTOR_CANCELADO =
  'El pedido está cancelado: no se puede indicar quién lo recibe';

/**
 * CU-128: el cliente dueño indica quién va a recibir su pedido (nombre,
 * documento y relación) mientras no esté entregado ni cancelado. El pedido se
 * lee con lock y el estado se re-chequea adentro, así que si se entrega o se
 * cancela en paralelo, esta operación falla con 409 sin escribir.
 *
 * Son datos personales de un tercero: se anulan al vencer el plazo de reclamo
 * (`ReceiverRetentionCron`) y el documento no entra en la auditoría
 * (`PROPIEDADES_EXCLUIDAS` y `SENSIBLES`).
 */
@Injectable()
export class SetOrderReceiverUseCase {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    orderId: string,
    dto: SetOrderReceiverDto,
    customerUserId: string,
    distributorId: string | null,
  ): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .where('ord.orderId = :id', { id: orderId })
        .getOne();

      // Lo ajeno (otro cliente u otra distribuidora) es 404, como el detalle.
      if (
        !order ||
        order.customerId !== customerUserId ||
        (distributorId && order.distributorId !== distributorId)
      ) {
        throw new NotFoundException('Pedido no encontrado');
      }
      if (order.status === OrderStatus.DELIVERED) {
        throw new ConflictException(MENSAJE_RECEPTOR_ENTREGADO);
      }
      if (order.status === OrderStatus.CANCELLED) {
        throw new ConflictException(MENSAJE_RECEPTOR_CANCELADO);
      }

      order.receiverName = dto.receiverName;
      order.receiverDocument = dto.receiverDocument;
      order.receiverRelationship = dto.receiverRelationship;
      await manager.save(order);
      return order.orderId;
    });
  }
}
