import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, EntityManager } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import { DisponibilidadDelChoferDto } from './dto/disponibilidad-response.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { RedisService } from '../redis/redis.service';
import { puntoDesdeLatLng } from '../common/geo/punto';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';

/** Lo que el alta guarda en el perfil de un chofer nuevo. */
export interface PerfilDeChoferNuevo {
  latLng?: string;
  actual_location?: string;
  validated?: boolean;
  isActive?: boolean;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
    private readonly redisService: RedisService,
  ) {}

  /**
   * El perfil de chofer de un usuario recién creado, dentro de la transacción
   * del alta (RegistroService). La distribuidora ya viene autorizada.
   */
  async crearPerfil(
    manager: EntityManager,
    userId: string,
    distributorId: string,
    datos: PerfilDeChoferNuevo,
  ): Promise<void> {
    const repo = manager.getRepository(Delivery);
    await repo.save(
      repo.create({
        userId,
        distributorId,
        calification: 0,
        location: datos.latLng ? puntoDesdeLatLng(datos.latLng) : null,
        actualLocation: datos.actual_location,
        validated: datos.validated ?? false,
        isActive: datos.isActive ?? true,
        balance: 0,
      }),
    );
  }

  /** Lista choferes, scopeada por distribuidora si se pasa `distributorId`. */
  async findAll(
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ): Promise<Delivery[]> {
    const { limit = 10, offset = 0 } = paginationDto;

    return await this.deliveryRepository.find({
      where: distributorId ? { distributorId } : {},
      take: limit,
      skip: offset,
      relations: ['user', 'user.role'],
    });
  }

  /** El token push del chofer, o null si no es chofer o no registró ninguno. */
  async findNotificationToken(userId: string): Promise<string | null> {
    const delivery = await this.deliveryRepository.findOne({
      where: { userId },
    });
    return delivery?.notificationToken ?? null;
  }

  /** Guarda el token push del chofer. Devuelve false si no es chofer. */
  async saveNotificationToken(userId: string, token: string): Promise<boolean> {
    const delivery = await this.deliveryRepository.findOne({
      where: { userId },
    });
    if (!delivery) return false;
    delivery.notificationToken = token;
    await this.deliveryRepository.save(delivery);
    return true;
  }

  /**
   * Propiedad del dato (H-64): un chofer sólo opera sobre su propio perfil y un
   * admin de empresa sólo sobre los de su distribuidora. El super_admin llega
   * sin distribuidora y sin dueño, y pasa.
   */
  assertAlcance(
    delivery: Delivery,
    duenoUserId?: string | null,
    distributorId?: string | null,
  ): void {
    if (duenoUserId && delivery.userId !== duenoUserId) {
      throw new ForbiddenException('No podés operar sobre otro chofer');
    }
    if (distributorId && delivery.distributorId !== distributorId) {
      throw new NotFoundException(
        `Delivery with ID: ${delivery.deliveryId} not found`,
      );
    }
  }

  /** El chofer sin relaciones, o null. Para los módulos que sólo necesitan su user_id. */
  findById(id: string): Promise<Delivery | null> {
    return this.deliveryRepository.findOne({ where: { deliveryId: id } });
  }

  /**
   * El perfil de chofer por su `delivery_id` o por el `user_id` de la persona
   * (el pedido guarda el primero y el token trae el segundo), o null. Con
   * `conUsuario`, trae además la persona.
   */
  buscarPorIdOUsuario(
    id: string,
    conUsuario = false,
  ): Promise<Delivery | null> {
    return this.deliveryRepository.findOne({
      where: [{ deliveryId: id }, { userId: id }],
      relations: conUsuario ? ['user'] : [],
    });
  }

  /** De esos usuarios, los que son choferes de la distribuidora. */
  async choferesDeLaDistribuidora(
    userIds: string[],
    distributorId: string,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const filas = await this.deliveryRepository.find({
      where: { userId: In(userIds), distributorId },
      select: { userId: true },
    });
    return filas.map((f) => f.userId);
  }

  /** Cuántos choferes activos y validados hay, en una distribuidora o en todas. */
  contarDisponibles(distributorId?: string | null): Promise<number> {
    return this.deliveryRepository.count({
      where: {
        isActive: true,
        validated: true,
        ...(distributorId ? { distributorId } : {}),
      },
    });
  }

  /** Guarda el promedio de calificaciones del chofer, para lecturas rápidas. */
  async updateCalificationByUserId(
    userId: string,
    average: number,
  ): Promise<void> {
    await this.deliveryRepository.update({ userId }, { calification: average });
  }

  async findOne(id: string): Promise<Delivery> {
    const delivery = await this.deliveryRepository.findOne({
      where: { deliveryId: id },
      relations: ['user', 'user.role'],
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery with ID: ${id} not found`);
    }

    return delivery;
  }

  /**
   * La distribuidora del chofer con ese `user_id`, o null si el usuario no es
   * chofer. Para los módulos que asignan algo a un chofer (vehículos).
   */
  async findDistributorIdByUserId(userId: string): Promise<string | null> {
    const delivery = await this.deliveryRepository.findOne({
      where: { userId },
      select: { deliveryId: true, distributorId: true },
    });
    return delivery?.distributorId ?? null;
  }

  async findOneByUserId(userId: string): Promise<Delivery> {
    const delivery = await this.deliveryRepository.findOne({
      where: { userId },
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

  async findActiveDeliveries(
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ): Promise<Delivery[]> {
    const { limit = 10, offset = 0 } = paginationDto;

    return await this.deliveryRepository.find({
      where: {
        isActive: true,
        ...(distributorId ? { distributorId } : {}),
      },
      take: limit,
      skip: offset,
      relations: ['user', 'user.role'],
    });
  }

  async update(
    id: string,
    updateDeliveryDto: UpdateDeliveryDto,
    distributorId?: string | null,
  ): Promise<Delivery> {
    // Un admin de empresa sólo edita choferes de su distribuidora (H-61); el
    // super_admin llega sin distributorId y no tiene esa restricción.
    if (distributorId) {
      const actual = await this.deliveryRepository.findOne({
        where: { deliveryId: id },
      });
      if (!actual || actual.distributorId !== distributorId) {
        throw new NotFoundException(`Delivery with ID: ${id} not found`);
      }
    }

    const delivery = await this.deliveryRepository.preload({
      deliveryId: id,
      ...updateDeliveryDto,
    });

    if (!delivery) {
      throw new NotFoundException(`Delivery with ID: ${id} not found`);
    }

    await this.deliveryRepository.save(delivery);
    return await this.findOne(id);
  }

  async remove(id: string): Promise<MessageResponseDto> {
    await this.findOne(id);
    await this.deliveryRepository.softDelete({ deliveryId: id });
    return MessageResponseDto.of('Delivery deleted successfully');
  }

  async validateDelivery(id: string): Promise<Delivery> {
    const delivery = await this.findOne(id);
    delivery.validated = true;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async invalidateDelivery(id: string): Promise<Delivery> {
    const delivery = await this.findOne(id);
    delivery.validated = false;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async updateLocation(
    id: string,
    latLng: string,
    actualLocation?: string,
    duenoUserId?: string | null,
  ): Promise<Delivery> {
    const delivery = await this.findOne(id);
    this.assertAlcance(delivery, duenoUserId);
    delivery.location = puntoDesdeLatLng(latLng);
    if (actualLocation) {
      delivery.actualLocation = actualLocation;
    }
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async updateBalance(id: string, amount: number): Promise<Delivery> {
    const delivery = await this.findOne(id);
    delivery.balance = (delivery.balance || 0) + amount;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async toggleActiveStatus(id: string, isActive: boolean): Promise<Delivery> {
    const delivery = await this.findOne(id);
    delivery.isActive = isActive;
    await this.deliveryRepository.save(delivery);
    return delivery;
  }

  async toggleAvailability(
    userId: string,
    isAvailable: boolean,
    distributorId?: string | null,
  ): Promise<DisponibilidadDelChoferDto> {
    const delivery = await this.deliveryRepository.findOne({
      where: { userId },
    });

    if (!delivery) {
      throw new NotFoundException(
        'Perfil de repartidor no encontrado para este usuario',
      );
    }
    this.assertAlcance(delivery, null, distributorId);

    delivery.isActive = isAvailable;
    await this.deliveryRepository.save(delivery);

    // Fuera de línea, sale del radar de despacho.
    if (!isAvailable) {
      // El radar `drivers:locations` se llena por `user_id` (lo setea
      // `driver:update-location` vía `updateDriverLocation(userId,...)`), así que
      // hay que sacarlo por `user_id`. Con `delivery_id` el ZREM era un no-op y el
      // chofer offline seguía en el radar recibiendo ofertas (CU-022).
      await this.redisService.removeDriver(userId);
    }

    return {
      userId,
      deliveryId: delivery.deliveryId,
      isAvailable: delivery.isActive,
      message: isAvailable ? 'Estás en línea 🟢' : 'Estás desconectado 🔴',
    };
  }

  /**
   * Delega en el traductor compartido. Antes cada servicio tenia su propia
   * copia: contemplaban uno o dos codigos de Postgres y convertian todo lo
   * demas en un 500 sin registrar la causa, asi que el mensaje mandaba a
   * mirar unos logs donde el error no estaba.
   */
  private handleDBExceptions(error: unknown): never {
    return traducirErrorDeBase(error, this.logger, 'choferes');
  }
}
