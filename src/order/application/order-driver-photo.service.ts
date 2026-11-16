import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus } from '../entities/order.entity';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { DeliveryService } from '../../delivery/delivery.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  EnlaceDeFoto,
  EntityPhotoService,
} from '../../s3/entity-photo.service';

/**
 * Renueva la foto firmada del chofer asignado a un pedido (la URL del evento de
 * socket vence en minutos). La ve el cliente dueño del pedido, el chofer
 * asignado y un admin de la distribuidora, y sólo mientras el pedido está
 * aceptado o en camino.
 */
@Injectable()
export class OrderDriverPhotoService {
  constructor(
    private readonly orders: OrderRepositoryPort,
    private readonly deliveries: DeliveryService,
    private readonly fotos: EntityPhotoService,
  ) {}

  async enlace(
    orderId: string,
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<EnlaceDeFoto> {
    const order = await this.orders.findByIdFull(orderId);
    const noExiste = new NotFoundException('Pedido no encontrado');
    if (!order) throw noExiste;
    if (distributorId && order.distributorId !== distributorId) throw noExiste;

    if (user.role === RoleType.CUSTOMER) {
      if (order.customerId !== user.user_id) throw noExiste;
    } else if (user.role === RoleType.DELIVERY) {
      const propio = await this.deliveries.buscarPorIdOUsuario(user.user_id);
      if (
        !propio ||
        !order.deliveryId ||
        propio.deliveryId !== order.deliveryId
      ) {
        throw new ForbiddenException(
          'Este pedido no está asignado a tu usuario',
        );
      }
    } else if (
      user.role !== RoleType.ADMIN &&
      user.role !== RoleType.SUPER_ADMIN
    ) {
      throw noExiste;
    }

    if (
      order.status !== OrderStatus.ACCEPTED &&
      order.status !== OrderStatus.ON_THE_WAY
    ) {
      throw new ConflictException(
        'La foto del chofer sólo está disponible con el pedido aceptado o en camino',
      );
    }
    return this.fotos.enlace(order.delivery?.user?.photoKey);
  }
}
