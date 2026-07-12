import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating, RaterRole } from './entities/rating.entity';
import { CreateRatingDto } from './dto/create-rating.dto';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { Delivery } from '../delivery/entities/delivery.entity';
import { RoleType } from '../common/constants/role-type.enum';

/** Resumen de calificaciones de un usuario (promedio + cantidad). */
export interface RatingSummary {
  average: number;
  count: number;
}

@Injectable()
export class RatingService {
  constructor(
    @InjectRepository(Rating)
    private readonly ratingRepository: Repository<Rating>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
  ) {}

  /**
   * Registra una calificación de UN lado del pedido. El emisor (fromUserId +
   * role) sale SIEMPRE del token; a quién califica se deriva del pedido (el otro
   * lado). Reglas:
   *  - el pedido debe estar DELIVERED,
   *  - el cliente sólo califica SUS pedidos; el chofer sólo los que entregó él,
   *  - una calificación por pedido y por lado (unique order_id + from_role).
   */
  async create(
    dto: CreateRatingDto,
    fromUserId: string,
    role: RoleType,
  ): Promise<Rating> {
    const order = await this.orderRepository.findOne({
      where: { order_id: dto.orderId },
      relations: ['delivery'],
    });
    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        'Solo se puede calificar un pedido entregado',
      );
    }

    const driverUserId = order.delivery?.user_id;
    let fromRole: RaterRole;
    let toUserId: string;

    if (role === RoleType.CUSTOMER) {
      if (order.customer_id !== fromUserId) {
        throw new ForbiddenException('No podés calificar un pedido de otro cliente');
      }
      if (!driverUserId) {
        throw new BadRequestException('El pedido no tiene chofer para calificar');
      }
      fromRole = RaterRole.CUSTOMER;
      toUserId = driverUserId;
    } else if (role === RoleType.DELIVERY) {
      if (driverUserId !== fromUserId) {
        throw new ForbiddenException('No podés calificar un pedido que no entregaste');
      }
      fromRole = RaterRole.DELIVERY;
      toUserId = order.customer_id;
    } else {
      throw new ForbiddenException('Solo cliente o chofer pueden calificar');
    }

    const rating = this.ratingRepository.create({
      order_id: order.order_id,
      distributor_id: order.distributor_id,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      from_role: fromRole,
      stars: dto.stars,
      comment: dto.comment,
    });

    let saved: Rating;
    try {
      saved = await this.ratingRepository.save(rating);
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException('Ya calificaste este pedido');
      }
      throw error;
    }

    // Si el cliente calificó al chofer, recalculamos el promedio del chofer y lo
    // persistimos en su perfil (Delivery.calification) para lecturas rápidas.
    if (fromRole === RaterRole.CUSTOMER) {
      await this.refreshDeliveryAverage(toUserId);
    }

    return saved;
  }

  /** Promedio + cantidad de calificaciones recibidas por un usuario (como chofer). */
  async getSummaryForUser(
    toUserId: string,
    distributorId?: string | null,
  ): Promise<RatingSummary> {
    const qb = this.ratingRepository
      .createQueryBuilder('r')
      .select('COALESCE(AVG(r.stars), 0)', 'average')
      .addSelect('COUNT(r.rating_id)', 'count')
      .where('r.to_user_id = :toUserId', { toUserId })
      .andWhere('r.from_role = :role', { role: RaterRole.CUSTOMER });

    if (distributorId) {
      qb.andWhere('r.distributor_id = :distributorId', { distributorId });
    }

    const raw = await qb.getRawOne<{ average: string; count: string }>();
    return {
      average: raw ? Math.round(Number(raw.average) * 100) / 100 : 0,
      count: raw ? Number(raw.count) : 0,
    };
  }

  /** Calificaciones recibidas por un usuario (historial), scopeado por tenant. */
  async findForUser(
    toUserId: string,
    distributorId?: string | null,
  ): Promise<Rating[]> {
    return this.ratingRepository.find({
      where: {
        to_user_id: toUserId,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /** Recalcula y persiste el promedio del chofer en su perfil Delivery. */
  private async refreshDeliveryAverage(driverUserId: string): Promise<void> {
    const { average } = await this.getSummaryForUser(driverUserId);
    await this.deliveryRepository.update(
      { user_id: driverUserId },
      { calification: average },
    );
  }
}
