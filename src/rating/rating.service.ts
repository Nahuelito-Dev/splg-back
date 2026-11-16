import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating, RaterRole } from './entities/rating.entity';
import { CreateRatingDto } from './dto/create-rating.dto';
import { OrderStatus } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import { DeliveryService } from '../delivery/delivery.service';
import { errorCode } from '../common/errors/error-message';
import { RoleType } from '../common/constants/role-type.enum';
import { RatingSummaryDto } from './dto/rating-response.dto';

@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name);

  constructor(
    @InjectRepository(Rating)
    private readonly ratingRepository: Repository<Rating>,
    private readonly orderService: OrderService,
    private readonly deliveryService: DeliveryService,
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
    const order = await this.orderService.findById(dto.orderId);
    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        'Solo se puede calificar un pedido entregado',
      );
    }

    const driverUserId = order.deliveryId
      ? (await this.deliveryService.findById(order.deliveryId))?.userId
      : undefined;
    let fromRole: RaterRole;
    let toUserId: string;

    if (role === RoleType.CUSTOMER) {
      if (order.customerId !== fromUserId) {
        throw new ForbiddenException(
          'No podés calificar un pedido de otro cliente',
        );
      }
      if (!driverUserId) {
        throw new BadRequestException(
          'El pedido no tiene chofer para calificar',
        );
      }
      fromRole = RaterRole.CUSTOMER;
      toUserId = driverUserId;
    } else if (role === RoleType.DELIVERY) {
      if (driverUserId !== fromUserId) {
        throw new ForbiddenException(
          'No podés calificar un pedido que no entregaste',
        );
      }
      fromRole = RaterRole.DELIVERY;
      toUserId = order.customerId;
    } else {
      throw new ForbiddenException('Solo cliente o chofer pueden calificar');
    }

    const rating = this.ratingRepository.create({
      orderId: order.orderId,
      distributorId: order.distributorId,
      fromUserId,
      toUserId,
      fromRole,
      stars: dto.stars,
      comment: dto.comment ?? null,
    });

    let saved: Rating;
    try {
      saved = await this.ratingRepository.save(rating);
    } catch (error) {
      if (errorCode(error) === '23505') {
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

  /**
   * Promedio + cantidad de calificaciones RECIBIDAS por un usuario. Simétrico:
   * sirve tanto para un chofer (recibe de clientes) como para un cliente
   * (recibe de choferes) — el `to_user_id` ya determina de qué lado vienen las
   * calificaciones, así que NO se filtra por `from_role` (filtrarlo por CUSTOMER
   * daba 0 para los clientes).
   */
  async getSummaryForUser(
    toUserId: string,
    distributorId?: string | null,
  ): Promise<RatingSummaryDto> {
    const qb = this.ratingRepository
      .createQueryBuilder('r')
      .select('COALESCE(AVG(r.stars), 0)', 'average')
      .addSelect('COUNT(r.ratingId)', 'count')
      .where('r.toUserId = :toUserId', { toUserId })
      .andWhere('r.hidden = false');

    if (distributorId) {
      qb.andWhere('r.distributorId = :distributorId', { distributorId });
    }

    const raw = await qb.getRawOne<{ average: string; count: string }>();
    return RatingSummaryDto.de(
      raw ? Math.round(Number(raw.average) * 100) / 100 : 0,
      raw ? Number(raw.count) : 0,
    );
  }

  /** Ficha de una calificación (oculta o no), acotada por tenant. */
  async findOne(id: string, distributorId?: string | null): Promise<Rating> {
    const rating = await this.ratingRepository.findOne({
      where: {
        ratingId: id,
        ...(distributorId ? { distributorId } : {}),
      },
      withDeleted: true,
      relations: ['fromUser'],
    });
    if (!rating) throw new NotFoundException('Calificación no encontrada');
    return rating;
  }

  /**
   * Oculta una calificación con motivo (moderación en vez de borrar). Deja de
   * contar en promedios; si era del cliente al chofer, se recalcula el
   * promedio de su perfil.
   */
  async hide(
    id: string,
    reason: string,
    actorUserId: string,
    distributorId: string,
  ): Promise<Rating> {
    const rating = await this.findOne(id, distributorId);
    if (rating.hidden) {
      throw new ConflictException('La calificación ya está oculta');
    }
    rating.hidden = true;
    rating.hiddenReason = reason;
    rating.hiddenAt = new Date();
    rating.hiddenByUserId = actorUserId;
    return this.guardarModerada(rating);
  }

  /** Vuelve a mostrar una calificación oculta; vuelve a contar en los promedios. */
  async unhide(
    id: string,
    reason: string,
    distributorId: string,
  ): Promise<Rating> {
    const rating = await this.findOne(id, distributorId);
    if (!rating.hidden) {
      throw new ConflictException('La calificación no está oculta');
    }
    this.logger.log(`Calificación ${id} vuelve a mostrarse: ${reason}`);
    rating.hidden = false;
    rating.hiddenReason = null;
    rating.hiddenAt = null;
    rating.hiddenByUserId = null;
    return this.guardarModerada(rating);
  }

  private async guardarModerada(rating: Rating): Promise<Rating> {
    await this.ratingRepository.save(rating);
    if (rating.fromRole === RaterRole.CUSTOMER) {
      await this.refreshDeliveryAverage(rating.toUserId);
    }
    return this.findOne(rating.ratingId, rating.distributorId);
  }

  /** Calificaciones recibidas por un usuario (historial), scopeado por tenant. */
  async findForUser(
    toUserId: string,
    distributorId?: string | null,
  ): Promise<Rating[]> {
    return this.ratingRepository.find({
      where: {
        toUserId,
        ...(distributorId ? { distributorId } : {}),
      },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['fromUser'],
      order: { createdAt: 'DESC' },
    });
  }

  /** Recalcula y persiste el promedio del chofer en su perfil Delivery. */
  private async refreshDeliveryAverage(driverUserId: string): Promise<void> {
    const { average } = await this.getSummaryForUser(driverUserId);
    await this.deliveryService.updateCalificationByUserId(
      driverUserId,
      average,
    );
  }
}
