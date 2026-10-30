import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { In, Repository, EntityManager } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import { DisponibilidadDelChoferDto } from './dto/disponibilidad-response.dto';
import { DeliveryStatusFilter } from './dto/query-delivery.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';
import { puntoDesdeLatLng } from '../common/geo/punto';
import { normalizarEmail } from '../common/utils/email.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { errorMessage } from '../common/errors/error-message';

/** Lo que el alta guarda en el perfil de un chofer nuevo. */
export interface PerfilDeChoferNuevo {
  latLng?: string;
  actual_location?: string;
  validated?: boolean;
  /** Habilitación administrativa inicial. Arranca siempre desconectado (`isAvailable: false`). */
  isEnabled?: boolean;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
    private readonly redisService: RedisService,
    private readonly usersService: UsersService,
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
        isEnabled: datos.isEnabled ?? true,
        // Un chofer nuevo arranca desconectado: todavía no abrió la app.
        isAvailable: false,
        balance: 0,
      }),
    );
  }

  /**
   * Lista choferes, scopeada por distribuidora si se pasa `distributorId`.
   * `term` busca por nombre, email o teléfono del chofer, y por la patente de
   * su vehículo (sin N+1: una subconsulta `EXISTS`, no un join que multiplique
   * filas). `status` filtra por uno de los cuatro grupos administrativos
   * (habilitados/deshabilitados/en línea/sin validar), para que el panel pueda
   * listar cada uno con su total (`X-Total-Count`).
   */
  async findAll(
    paginationDto: PaginationDto,
    distributorId?: string | null,
    status?: DeliveryStatusFilter,
  ): Promise<[Delivery[], number]> {
    const { limit = 10, offset = 0, term } = paginationDto;
    return this.buscarChoferes(limit, offset, distributorId, term, { status });
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
        `Chofer ${delivery.deliveryId} no encontrado`,
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

  /**
   * De esos usuarios (`user_id`, lo que trae el radar de Redis), los que son
   * choferes EN CONDICIONES de recibir una oferta: habilitados y validados
   * (y de la distribuidora, si se pasa). Preserva el orden de entrada, que en
   * el radar es el de cercanía.
   *
   * La usa el despacho (`DispatchOrchestratorService.findNearestAvailable`)
   * como el filtro real de elegibilidad: el radar de Redis sólo sabe de
   * ubicación, no de habilitación ni de validación, así que sin este chequeo
   * un chofer deshabilitado o sin validar que igual quedara en el radar (por
   * ejemplo, conectado por socket sin pasar por `toggleAvailability`) seguiría
   * recibiendo pedidos.
   */
  async choferesElegibles(
    userIds: string[],
    distributorId?: string | null,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const filas = await this.deliveryRepository.find({
      where: {
        userId: In(userIds),
        isEnabled: true,
        validated: true,
        ...(distributorId ? { distributorId } : {}),
      },
      select: { userId: true },
    });
    const elegibles = new Set(filas.map((f) => f.userId));
    return userIds.filter((id) => elegibles.has(id));
  }

  /**
   * `delivery_id` de esos usuarios (`user_id`), en lote. Lo usa
   * `FleetTaskService` para saber a qué chofer corresponde cada tarea de
   * flota (CU-136 a CU-138) sin un `findOne` por candidato del despacho.
   */
  async findDeliveryIdsByUserIds(
    userIds: string[],
    distributorId?: string | null,
  ): Promise<Array<{ userId: string; deliveryId: string }>> {
    if (userIds.length === 0) return [];
    const filas = await this.deliveryRepository.find({
      where: {
        userId: In(userIds),
        ...(distributorId ? { distributorId } : {}),
      },
      select: { userId: true, deliveryId: true },
    });
    return filas.map((f) => ({ userId: f.userId, deliveryId: f.deliveryId }));
  }

  /** Cuántos choferes están habilitados, en una distribuidora o en todas. */
  contarHabilitados(distributorId?: string | null): Promise<number> {
    return this.deliveryRepository.count({
      where: {
        isEnabled: true,
        ...(distributorId ? { distributorId } : {}),
      },
    });
  }

  /**
   * Cuántos choferes están habilitados + validados + en línea: los que el
   * despacho considera disponibles ahora mismo para recibir un pedido.
   */
  contarEnLinea(distributorId?: string | null): Promise<number> {
    return this.deliveryRepository.count({
      where: {
        isEnabled: true,
        validated: true,
        isAvailable: true,
        ...(distributorId ? { distributorId } : {}),
      },
    });
  }

  /**
   * Uno de los DOS gates de asignación de un pedido a un chofer (el otro es
   * el de flota, `FleetDispatchLockService.assertChoferHabilitado`, CU-136 a
   * CU-138). Los tres caminos que le dan un pedido a un chofer —la
   * asignación manual (admin, `PATCH /orders/:id/assign/:deliveryId`), la
   * aceptación por `PATCH /orders/:id/status` con `status=accepted` (admin
   * con `deliveryId`, o el propio chofer desde el pool) y el despacho
   * automático— llaman a los dos. Éste sólo mira habilitado y validado. A
   * propósito NO exige que esté en línea (`isAvailable`): es un acto
   * explícito de asignación, no una búsqueda por el radar, y un admin puede
   * querer asignar a un chofer que sabe disponible aunque su app no lo
   * muestre conectado.
   */
  assertElegibleParaAsignacion(delivery: Delivery): void {
    if (!delivery.isEnabled) {
      throw new BadRequestException('El repartidor está deshabilitado');
    }
    if (!delivery.validated) {
      throw new BadRequestException('El repartidor no está validado');
    }
  }

  /** Guarda el promedio de calificaciones del chofer, para lecturas rápidas. */
  async updateCalificationByUserId(
    userId: string,
    average: number,
  ): Promise<void> {
    // `update` puntual (un `save` reescribiría la posición del chofer con un
    // valor viejo); la auditoría la asienta el trigger de la tabla.
    await this.deliveryRepository.update({ userId }, { calification: average });
  }

  async findOne(id: string): Promise<Delivery> {
    const delivery = await this.deliveryRepository.findOne({
      where: { deliveryId: id },
      relations: ['user', 'user.role'],
    });

    if (!delivery) {
      throw new NotFoundException(`Chofer ${id} no encontrado`);
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
      throw new NotFoundException(`No hay un chofer para el usuario ${userId}`);
    }

    return delivery;
  }

  async findOneByEmail(email: string): Promise<Delivery> {
    const delivery = await this.deliveryRepository
      .createQueryBuilder('delivery')
      .leftJoinAndSelect('delivery.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .where('LOWER(user.email) = :email', { email: normalizarEmail(email) })
      .getOne();

    if (!delivery) {
      throw new NotFoundException(`No hay un chofer con el correo ${email}`);
    }

    return delivery;
  }

  /**
   * `GET /delivery/active`: choferes en línea y listos para despachar
   * (habilitado + validado + `isAvailable`). Antes "activo" era sólo
   * `isActive`, que un chofer deshabilitado podía forzar a `true` desde su
   * propia app; ahora requiere los tres gates.
   */
  async findActiveDeliveries(
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ): Promise<[Delivery[], number]> {
    const { limit = 10, offset = 0, term } = paginationDto;
    return this.buscarChoferes(limit, offset, distributorId, term, {
      soloEnLinea: true,
    });
  }

  /**
   * Consulta compartida de `findAll`/`findActiveDeliveries`. Sin `term` usa el
   * camino simple de siempre (`findAndCount`); con `term` arma el WHERE con un
   * query builder para poder buscar por los datos del usuario y por la patente
   * del vehículo.
   */
  private async buscarChoferes(
    limit: number,
    offset: number,
    distributorId: string | null | undefined,
    term: string | undefined,
    opciones: { soloEnLinea?: boolean; status?: DeliveryStatusFilter } = {},
  ): Promise<[Delivery[], number]> {
    const termino = term?.trim();
    const filtroDeEstado = this.condicionDeEstado(opciones);
    if (!termino) {
      return this.deliveryRepository.findAndCount({
        where: {
          ...filtroDeEstado,
          ...(distributorId ? { distributorId } : {}),
        },
        take: limit,
        skip: offset,
        relations: ['user', 'user.role'],
        order: { deliveryId: 'ASC' },
      });
    }

    // `user` (one-to-one) y `role` (many-to-one desde `user`) no multiplican
    // filas: el `take`/`skip` de acá abajo pagina bien.
    const qb = this.deliveryRepository
      .createQueryBuilder('delivery')
      .leftJoinAndSelect('delivery.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .orderBy('delivery.deliveryId', 'ASC')
      .take(limit)
      .skip(offset);

    if (opciones.soloEnLinea) {
      qb.andWhere(
        'delivery.isEnabled = true AND delivery.validated = true AND delivery.isAvailable = true',
      );
    }
    if (opciones.status) {
      qb.andWhere(this.condicionSqlDeEstado(opciones.status));
    }
    if (distributorId) {
      qb.andWhere('delivery.distributorId = :distributorId', {
        distributorId,
      });
    }
    qb.andWhere(
      '(user.fullName ILIKE :term OR user.email ILIKE :term ' +
        'OR user.phoneNumber ILIKE :term ' +
        'OR EXISTS (SELECT 1 FROM car WHERE car.user_id = delivery.userId ' +
        'AND car.car_patent ILIKE :term AND car."deletedAt" IS NULL))',
      { term: `%${termino}%` },
    );

    return qb.getManyAndCount();
  }

  /** El WHERE de `findAndCount` para `soloEnLinea`/`status` (camino sin `term`). */
  private condicionDeEstado(opciones: {
    soloEnLinea?: boolean;
    status?: DeliveryStatusFilter;
  }): Partial<Record<'isEnabled' | 'validated' | 'isAvailable', boolean>> {
    if (opciones.soloEnLinea) {
      return { isEnabled: true, validated: true, isAvailable: true };
    }
    switch (opciones.status) {
      case DeliveryStatusFilter.ENABLED:
        return { isEnabled: true };
      case DeliveryStatusFilter.DISABLED:
        return { isEnabled: false };
      case DeliveryStatusFilter.ONLINE:
        return { isAvailable: true };
      case DeliveryStatusFilter.UNVALIDATED:
        return { validated: false };
      default:
        return {};
    }
  }

  /** La misma condición de `condicionDeEstado`, como fragmento SQL para el query builder. */
  private condicionSqlDeEstado(status: DeliveryStatusFilter): string {
    switch (status) {
      case DeliveryStatusFilter.ENABLED:
        return 'delivery.isEnabled = true';
      case DeliveryStatusFilter.DISABLED:
        return 'delivery.isEnabled = false';
      case DeliveryStatusFilter.ONLINE:
        return 'delivery.isAvailable = true';
      case DeliveryStatusFilter.UNVALIDATED:
        return 'delivery.validated = false';
    }
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
        throw new NotFoundException(`Chofer ${id} no encontrado`);
      }
    }

    const delivery = await this.deliveryRepository.preload({
      deliveryId: id,
      ...updateDeliveryDto,
    });

    if (!delivery) {
      throw new NotFoundException(`Chofer ${id} no encontrado`);
    }

    await this.deliveryRepository.save(delivery);
    return await this.findOne(id);
  }

  /**
   * Un chofer es de una sola distribuidora, así que darlo de baja es dar de
   * baja su cuenta: el usuario y el perfil quedan con `deletedAt` y su cuenta
   * de Firebase se deshabilita. Borrar sólo el perfil dejaba al usuario vivo,
   * sin rol utilizable y visible en Usuarios.
   *
   * Se rechaza (409, desde `UsersService.remove`) mientras tenga pedidos en
   * curso, que quedarían sin nadie que los entregue. Ya NO se rechaza por
   * tener vehículos asignados: la flota es de la distribuidora, no del usuario (`User.cars` perdió el `cascade`), y
   * si tenía un vehículo en uso lo libera `UsersService.remove` por el evento
   * `chofer.dado-de-baja` (lo escucha `VehicleReleaseOnBajaListener`), dentro
   * de la misma transacción de la baja.
   */
  async remove(id: string): Promise<MessageResponseDto> {
    const delivery = await this.findOne(id);

    // El 409 por pedidos en curso lo da `UsersService.remove`, con el chofer
    // bloqueado: un conteo hecho acá, antes del lock, no vería una
    // aceptación que se está confirmando.
    await this.usersService.remove(delivery.userId);

    // Recién con la baja confirmada sale del radar: si la baja falla, el
    // chofer sigue siendo un chofer vigente y no queda fuera del despacho.
    // Si Redis falla, la baja ya está hecha: se registra, no se revierte.
    try {
      await this.redisService.removeDriver(delivery.userId);
    } catch (error) {
      this.logger.error(
        `Chofer ${id} dado de baja, pero no se pudo sacar del radar de despacho: ${errorMessage(error)}`,
      );
    }
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

  /**
   * Suma `amount` al saldo del chofer. Con la fila bloqueada: dos ajustes al
   * mismo tiempo se aplican uno detrás del otro y ninguno se pierde.
   */
  async updateBalance(id: string, amount: number): Promise<Delivery> {
    await this.deliveryRepository.manager.transaction(async (manager) => {
      const delivery = await manager
        .createQueryBuilder(Delivery, 'delivery')
        .setLock('pessimistic_write')
        .where('delivery.deliveryId = :id', { id })
        .getOne();
      if (!delivery) {
        throw new NotFoundException(`Chofer ${id} no encontrado`);
      }
      delivery.balance = new Decimal(delivery.balance || 0)
        .plus(amount)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber();
      await manager.save(delivery);
    });
    return this.findOne(id);
  }

  /**
   * Habilitación ADMINISTRATIVA (`PATCH /delivery/:id/status`). Al
   * deshabilitar, el chofer también sale de línea y del radar de Redis: sin
   * esto, un chofer que ya estaba conectado seguía recibiendo ofertas después
   * de que el admin lo diera de baja.
   */
  async toggleActiveStatus(id: string, isEnabled: boolean): Promise<Delivery> {
    const delivery = await this.findOne(id);
    delivery.isEnabled = isEnabled;
    if (!isEnabled) {
      delivery.isAvailable = false;
    }
    await this.deliveryRepository.save(delivery);

    if (!isEnabled) {
      await this.redisService.removeDriver(delivery.userId);
    }

    return delivery;
  }

  /** El perfil de chofer de un usuario dentro de la transacción de quien llama, o null si no tiene. */
  findByUserIdEnTransaccion(
    manager: EntityManager,
    userId: string,
  ): Promise<Delivery | null> {
    return manager.getRepository(Delivery).findOne({ where: { userId } });
  }

  /**
   * Deshabilita al chofer y lo pone fuera de línea, dentro de la transacción de
   * quien llama (el egreso de un empleado). Sacarlo del radar de Redis es
   * `quitarDelRadar`, que se hace recién con la transacción confirmada.
   */
  async deshabilitarEnTransaccion(
    manager: EntityManager,
    deliveryId: string,
  ): Promise<void> {
    await manager
      .getRepository(Delivery)
      .update({ deliveryId }, { isEnabled: false, isAvailable: false });
  }

  /** Saca al chofer del radar de despacho. Si Redis falla se registra: no revierte nada. */
  async quitarDelRadar(userId: string): Promise<void> {
    try {
      await this.redisService.removeDriver(userId);
    } catch (error) {
      this.logger.error(
        `No se pudo sacar al chofer del usuario ${userId} del radar de despacho: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Presencia (`PATCH /delivery/user/:userId/availability`), la pone el
   * propio chofer al conectarse/desconectarse desde su app.
   *
   * Ponerse EN LÍNEA exige estar habilitado y validado: es el fix del bug de
   * fondo (CU-022 ampliado). Antes esto pisaba la misma columna que usaba la
   * habilitación administrativa, así que un chofer deshabilitado por el admin
   * podía "reactivarse" solo con este endpoint. Desconectarse (`isAvailable:
   * false`) siempre se permite, esté habilitado o no.
   */
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

    if (isAvailable) {
      if (!delivery.isEnabled) {
        throw new ForbiddenException(
          'No podés ponerte en línea: tu cuenta está deshabilitada por el administrador',
        );
      }
      if (!delivery.validated) {
        throw new ForbiddenException(
          'No podés ponerte en línea: tu perfil todavía no fue validado',
        );
      }
    }

    delivery.isAvailable = isAvailable;
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
      isAvailable: delivery.isAvailable,
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
