import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class DeliveryService {
  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
    private readonly redisService: RedisService,
  ) {}

  /** Lista choferes, scopeada por distribuidora si se pasa `distributorId`. */
  async findAll(paginationDto: PaginationDto, distributorId?: string | null) {
    const { limit = 10, offset = 0 } = paginationDto;

    return await this.deliveryRepository.find({
      where: distributorId ? { distributor_id: distributorId } : {},
      take: limit,
      skip: offset,
      relations: ['user', 'user.role'],
    });
  }

  async findOne(id: string) {
    const delivery = await this.deliveryRepository.findOne({
      where: { delivery_id: id },
      relations: ['user', 'user.role'],
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery with ID: ${id} not found`);
    }

    return delivery;
  }

  async findOneByUserId(userId: string) {
    const delivery = await this.deliveryRepository.findOne({
      where: { user_id: userId },
      relations: ['user', 'user.role'],
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery for user ID: ${userId} not found`);
    }

    return delivery;
  }

  async findOneByEmail(email: string): Promise<Delivery> {
    const delivery = await this.deliveryRepository
      .createQueryBuilder('delivery')
      .leftJoinAndSelect('delivery.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .where('user.email = :email', { email })
      .getOne();

    if (!delivery) {
      throw new NotFoundException(`Delivery with email: ${email} not found`);
    }

    return delivery;
  }

  async findActiveDeliveries(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;

    return await this.deliveryRepository.find({
      where: { isActive: true },
      take: limit,
      skip: offset,
      relations: ['user', 'user.role'],
    });
  }

  async update(id: string, updateDeliveryDto: UpdateDeliveryDto) {
    const delivery = await this.deliveryRepository.preload({
      delivery_id: id,
      ...updateDeliveryDto,
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery with ID: ${id} not found`);
    }

    await this.deliveryRepository.save(delivery);
    return await this.findOne(id);
  }

  async remove(id: string) {
    const delivery = await this.findOne(id);
    await this.deliveryRepository.softDelete({ delivery_id: id });
    return { message: 'Delivery deleted successfully' };
  }

  async validateDelivery(id: string) {
    const delivery = await this.findOne(id);
    delivery.validated = true;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async invalidateDelivery(id: string) {
    const delivery = await this.findOne(id);
    delivery.validated = false;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async updateLocation(id: string, latLng: string, actualLocation?: string) {
    const delivery = await this.findOne(id);
    delivery.latLng = latLng;
    if (actualLocation) {
      delivery.actual_location = actualLocation;
    }
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async updateBalance(id: string, amount: number) {
    const delivery = await this.findOne(id);
    delivery.balance = (delivery.balance || 0) + amount;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async toggleActiveStatus(id: string, isActive: boolean) {
    const delivery = await this.findOne(id);
    delivery.isActive = isActive;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async toggleAvailability(userId: string, isAvailable: boolean) {
    // 1. Buscamos el delivery asociado a ese usuario
    const delivery = await this.deliveryRepository.findOne({
      where: { user_id: userId }, // <--- CAMBIO CRUCIAL: Buscamos por user_id
    });

    if (!delivery) {
      throw new NotFoundException(
        'Perfil de repartidor no encontrado para este usuario',
      );
    }

    // 2. Actualizamos el estado
    delivery.isActive = isAvailable;
    await this.deliveryRepository.save(delivery);

    // 3. Gestionamos Redis (Geolocalización)
    if (!isAvailable) {
      // El radar `drivers:locations` se llena por `user_id` (lo setea
      // `driver:update-location` vía `updateDriverLocation(userId,...)`), así que
      // hay que sacarlo por `user_id`. Con `delivery_id` el ZREM era un no-op y el
      // chofer offline seguía en el radar recibiendo ofertas (CU-022).
      await this.redisService.removeDriver(userId);
    }

    return {
      userId: userId, // Devolvemos el userId para confirmar
      deliveryId: delivery.delivery_id,
      isAvailable: delivery.isActive,
      message: isAvailable ? 'Estás en línea 🟢' : 'Estás desconectado 🔴',
    };
  }

  private handleDBExceptions(error: any) {
    if (error.status === 404 || error.status === 400) {
      throw error;
    }
    if (error.code === '23505') {
      throw new BadRequestException('Duplicate entry', error.detail);
    }
    if (error.code === '23503') {
      throw new BadRequestException('Foreign key constraint failed');
    }
    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
  }
}
