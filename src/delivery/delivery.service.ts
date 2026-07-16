import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { RedisService } from '../redis/redis.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../role/entities/role.entity';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
    private readonly redisService: RedisService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    private readonly dataSource: DataSource,
    private readonly firebaseAuth: FirebaseAuthPort,
  ) {}

  /**
   * Registro completo: User + Delivery + Firebase, en una transacción.
   * Movido acá desde `UsersService.createDeliveryWithUser` (P2-3) para que
   * `UsersService` deje de conocer entidades de otros dominios.
   */
  async registerWithUser(createDeliveryDto: CreateDeliveryDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const existingUser = await this.userRepository.findOne({
        where: { email: createDeliveryDto.email },
      });

      if (existingUser) {
        throw new BadRequestException('User with this email already exists');
      }

      const firebaseUser = await this.firebaseAuth.createUserSafe({
        email: createDeliveryDto.email,
        password: createDeliveryDto.password,
        full_name: createDeliveryDto.full_name,
        phone_number: createDeliveryDto.phone_number,
      });

      const deliveryRole = await this.roleRepository.findOne({
        where: { type: 'delivery' },
      });

      if (!deliveryRole) {
        throw new InternalServerErrorException('Delivery role not found');
      }

      const user = this.userRepository.create({
        email: createDeliveryDto.email,
        full_name: createDeliveryDto.full_name,
        phone_number: createDeliveryDto.phone_number,
        firebase_uid: firebaseUser.uid,
        role_id: deliveryRole.role_id,
        email_verified: false,
        phone_verified: false,
        blocked: false,
        selfie: createDeliveryDto.selfie,
      });

      const savedUser = await queryRunner.manager.save(user);

      const delivery = this.deliveryRepository.create({
        user_id: savedUser.user_id,
        distributor_id: createDeliveryDto.distributorId,
        calification: createDeliveryDto.calification || 0,
        latLng: createDeliveryDto.latLng,
        actual_location: createDeliveryDto.actual_location,
        validated: createDeliveryDto.validated || false,
        isActive:
          createDeliveryDto.isActive !== undefined
            ? createDeliveryDto.isActive
            : true,
        balance: 0,
      });

      await queryRunner.manager.save(delivery);
      await queryRunner.commitTransaction();

      const result = await this.userRepository.findOne({
        where: { user_id: savedUser.user_id },
        relations: ['delivery', 'role'],
      });

      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (createDeliveryDto.email) {
        await this.firebaseAuth.deleteUserByEmailSafe(
          createDeliveryDto.email,
          this.logger,
        );
      }

      this.handleDBExceptions(error);
    } finally {
      await queryRunner.release();
    }
  }

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
