import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, EntityManager } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { CustomerDistributor } from './entities/customer-distributor.entity';
import { bloquearCuentaParaBaja } from '../common/locks/cuenta-lock';
import { puntoDesdeLatLng } from '../common/geo/punto';
import { clienteDeLaDistribuidora } from '../common/tenancy/pertenencia';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import {
  CustomerStatusFilter,
  QueryCustomersDto,
} from './dto/query-customers.dto';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';

/** Estados de un pedido que todavía no terminó (impiden la baja del cliente). */
const ESTADOS_EN_CURSO = ['reserved', 'pending', 'accepted', 'on_the_way'];

/** Lo que el alta guarda en el perfil de un cliente nuevo. */
export interface PerfilDeClienteNuevo {
  lat_lang?: string;
  notification_token?: string;
  consumo?: ConsumoDeclarado;
}

/** El consumo promedio declarado por el cliente y la recompra que se estima de él. */
export interface ConsumoDeclarado {
  declaredCylinderTypeId: string;
  avgMonthlyConsumptionKg: number;
  nextRepurchaseEstimateAt: Date;
}

/** Lo que el módulo de recompra necesita de un cliente de la distribuidora. */
export interface FichaDeRecompra {
  /** El perfil de cliente (la ficha del panel se abre con él). */
  customerId: string;
  userId: string;
  fullName: string | null;
  email: string | null;
  phoneNumber: string | null;
  avgMonthlyConsumptionKg: number | null;
  declaredCylinderTypeId: string | null;
  /** Días de anticipación que eligió; `null`: rige el de la distribuidora. */
  noticeDays: number | null;
  /** `false`: pidió no recibir el aviso. */
  noticeEnabled: boolean;
}

/** Cómo el cliente quiere el aviso de recompra (CU-145). */
export interface PreferenciaDeAviso {
  noticeEnabled?: boolean;
  /** `null` vuelve al valor de la distribuidora. */
  noticeDays?: number | null;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger('CustomersService');

  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  /**
   * El perfil de cliente de un usuario recién creado, dentro de la
   * transacción del alta (RegistroService).
   */
  async crearPerfil(
    manager: EntityManager,
    userId: string,
    datos: PerfilDeClienteNuevo,
  ): Promise<void> {
    const repo = manager.getRepository(Customer);
    await repo.save(
      repo.create({
        userId,
        notificationToken: datos.notification_token ?? null,
        location: datos.lat_lang ? puntoDesdeLatLng(datos.lat_lang) : null,
        ...datos.consumo,
      }),
    );
  }

  /**
   * Registra que `distributorId` dio de alta al cliente, en la transacción del
   * alta. Idempotente: si el vínculo ya existe no lo duplica, y si estaba dado
   * de baja lo reactiva.
   */
  async vincularConDistribuidora(
    manager: EntityManager,
    userId: string,
    distributorId: string,
    creadoPorUserId: string | null,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(CustomerDistributor)
      .values({ userId, distributorId, createdByUserId: creadoPorUserId })
      .orUpdate(
        ['removed_at', 'removed_by_user_id'],
        ['user_id', 'distributor_id'],
      )
      .execute();
  }

  /**
   * Un pedido nuevo del cliente con la distribuidora deshace su baja, en la
   * transacción del pedido. Sin baja vigente no hace nada.
   */
  async reactivarVinculo(
    manager: EntityManager,
    userId: string,
    distributorId: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(CustomerDistributor)
      .set({ removedAt: null, removedByUserId: null })
      .where('user_id = :userId AND distributor_id = :distributorId', {
        userId,
        distributorId,
      })
      .andWhere('removed_at IS NOT NULL')
      .execute();
  }

  /**
   * Los clientes que la distribuidora dio de baja (vínculo con `removed_at`),
   * para que pueda reactivarlos. Sólo los suyos; la búsqueda es por nombre o
   * teléfono, nunca por correo.
   */
  async findRemoved(
    paginationDto: QueryCustomersDto,
    distributorId: string,
  ): Promise<[Customer[], number]> {
    const { limit = 10, offset = 0, term } = paginationDto;
    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.addresses', 'addresses')
      .leftJoinAndSelect(
        'customer.declaredCylinderType',
        'declaredCylinderType',
      )
      .where(
        `EXISTS (SELECT 1 FROM customer_distributor baja
         WHERE baja.user_id = customer.user_id
         AND baja.distributor_id = :distributorId
         AND baja.removed_at IS NOT NULL)`,
        { distributorId },
      )
      .orderBy('customer.createdAt', 'DESC')
      // Desempate: con la misma fecha la paginación no repite ni saltea filas.
      .addOrderBy('customer.customerId', 'ASC')
      .take(limit)
      .skip(offset);
    if (term) {
      qb.andWhere(
        new Brackets((b) => {
          b.where('user.fullName ILIKE :term').orWhere(
            'user.phoneNumber ILIKE :term',
          );
        }),
        { term: `%${term}%` },
      );
    }
    return qb.getManyAndCount();
  }

  /**
   * Deshace la baja del cliente en la distribuidora. 404 si no tiene un vínculo
   * dado de baja con ella (incluye al cliente de otra empresa).
   */
  async reactivarEnDistribuidora(
    customerId: string,
    distributorId: string,
  ): Promise<MessageResponseDto> {
    const customer = await this.findOne(customerId);
    const res = await this.customerRepository.manager
      .createQueryBuilder()
      .update(CustomerDistributor)
      .set({ removedAt: null, removedByUserId: null })
      .where('user_id = :userId AND distributor_id = :distributorId', {
        userId: customer.userId,
        distributorId,
      })
      .andWhere('removed_at IS NOT NULL')
      .execute();
    if (!res.affected) {
      throw new NotFoundException('Cliente no encontrado');
    }
    return MessageResponseDto.of('Cliente reactivado en la distribuidora');
  }

  /**
   * Baja del cliente en UNA distribuidora: lo saca de sus listados, ficha y
   * búsquedas sin tocar la cuenta, los pedidos ni su relación con otras
   * empresas. Si el cliente sólo le compró (sin fila de vínculo), la fila nace
   * ya dada de baja. 409 si tiene pedidos en curso con ella.
   */
  async darDeBajaEnDistribuidora(
    customerId: string,
    distributorId: string,
    removidoPorUserId: string,
  ): Promise<MessageResponseDto> {
    const customer = await this.findOne(customerId);
    await this.assertDeLaDistribuidora(
      { customer_id: customerId },
      distributorId,
    );
    await this.customerRepository.manager.transaction(async (manager) => {
      // Mismo lock que la baja de cuenta: un pedido que se está creando
      // termina antes de contar los pedidos en curso.
      await bloquearCuentaParaBaja(manager, customer.userId);
      const enCurso: unknown[] = await manager.query(
        `SELECT 1 FROM "order" WHERE customer_id = $1 AND distributor_id = $2
         AND status = ANY($3) LIMIT 1`,
        [customer.userId, distributorId, ESTADOS_EN_CURSO],
      );
      if (enCurso.length > 0) {
        throw new ConflictException(
          'El cliente tiene pedidos en curso con esta distribuidora: esperá a que terminen o cancelalos',
        );
      }
      await manager
        .createQueryBuilder()
        .insert()
        .into(CustomerDistributor)
        .values({
          userId: customer.userId,
          distributorId,
          createdByUserId: null,
          removedAt: new Date(),
          removedByUserId: removidoPorUserId,
        })
        .orUpdate(
          ['removed_at', 'removed_by_user_id'],
          ['user_id', 'distributor_id'],
        )
        .execute();
    });
    return MessageResponseDto.of('Cliente quitado de la distribuidora');
  }

  /**
   * Guarda el consumo declarado y la estimación de recompra en la ficha del
   * cliente (CU-144). El cálculo y la validación del rango los hace el módulo
   * de recompra: acá sólo se persiste.
   */
  async guardarConsumo(
    userId: string,
    consumo: ConsumoDeclarado,
  ): Promise<Customer> {
    // Sin la relación cargada: con `declaredCylinderType` presente, TypeORM
    // guardaría la garrafa vieja y pisaría el id nuevo.
    const customer = await this.customerRepository.findOne({
      where: { userId },
    });
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }
    Object.assign(customer, consumo);
    await this.customerRepository.save(customer);
    return this.findOneByUserId(userId);
  }

  /**
   * Los clientes de la distribuidora con lo que usa la recompra: consumo
   * declarado y preferencia de aviso (CU-145). Sin los bloqueados ni los que la
   * distribuidora dio de baja. Con `userIds`, sólo esos.
   */
  async fichasDeRecompra(
    distributorId: string,
    userIds?: readonly string[],
  ): Promise<FichaDeRecompra[]> {
    if (userIds && userIds.length === 0) return [];
    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .innerJoinAndSelect('customer.user', 'user')
      .where('user.blocked = false')
      .andWhere(clienteDeLaDistribuidora('customer.userId'), { distributorId });
    if (userIds) qb.andWhere('customer.userId IN (:...userIds)', { userIds });
    const clientes = await qb.getMany();
    return clientes.map((c) => ({
      customerId: c.customerId,
      userId: c.userId,
      fullName: c.user.fullName ?? null,
      email: c.user.email ?? null,
      phoneNumber: c.user.phoneNumber ?? null,
      avgMonthlyConsumptionKg: c.avgMonthlyConsumptionKg,
      declaredCylinderTypeId: c.declaredCylinderTypeId,
      noticeDays: c.repurchaseNoticeDays,
      noticeEnabled: c.repurchaseNoticeEnabled,
    }));
  }

  /**
   * CU-145. Guarda cómo quiere el cliente el aviso de recompra: activado o no,
   * y con cuántos días de anticipación (o los de la distribuidora). Sólo cambia
   * lo que viene.
   */
  async guardarAvisoDeRecompra(
    userId: string,
    preferencia: PreferenciaDeAviso,
  ): Promise<Customer> {
    const customer = await this.customerRepository.findOne({
      where: { userId },
    });
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }
    if (preferencia.noticeEnabled !== undefined) {
      customer.repurchaseNoticeEnabled = preferencia.noticeEnabled;
    }
    if (preferencia.noticeDays !== undefined) {
      customer.repurchaseNoticeDays = preferencia.noticeDays;
    }
    await this.customerRepository.save(customer);
    return customer;
  }

  /**
   * Lista clientes. Los clientes son GLOBALES (uno puede pedir a varias
   * distribuidoras), así que el scoping por tenant no es una columna sino una
   * relación: si viene `distributorId` (admin de empresa, o super_admin con
   * "ver como"), devuelve solo los clientes que le compraron o que ella dio de
   * alta. Sin él (super_admin cross-tenant) devuelve todos.
   */
  /**
   * El token push del cliente. `esCliente` en false si el usuario no tiene
   * perfil de cliente; `token` en null si no registró ningún dispositivo.
   */
  async findNotificationToken(
    userId: string,
  ): Promise<{ esCliente: boolean; token: string | null }> {
    const customer = await this.customerRepository.findOne({
      where: { userId },
    });
    return {
      esCliente: Boolean(customer),
      token: customer?.notificationToken ?? null,
    };
  }

  /** Guarda el token push del cliente. Devuelve false si no es cliente. */
  async saveNotificationToken(userId: string, token: string): Promise<boolean> {
    const customer = await this.customerRepository.findOne({
      where: { userId },
    });
    if (!customer) return false;
    customer.notificationToken = token;
    await this.customerRepository.save(customer);
    return true;
  }

  async findAll(
    paginationDto: QueryCustomersDto,
    distributorId?: string | null,
  ): Promise<[Customer[], number]> {
    const { limit = 10, offset = 0, term, status } = paginationDto;

    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.addresses', 'addresses')
      .leftJoinAndSelect(
        'customer.declaredCylinderType',
        'declaredCylinderType',
      )
      .orderBy('customer.createdAt', 'DESC')
      .addOrderBy('customer.customerId', 'ASC')
      .take(limit)
      .skip(offset);

    // Búsqueda por nombre, email o teléfono, como en el listado de usuarios.
    if (term) {
      qb.andWhere(
        new Brackets((b) => {
          b.where('user.fullName ILIKE :term')
            .orWhere('user.email ILIKE :term')
            .orWhere('user.phoneNumber ILIKE :term');
        }),
        { term: `%${term}%` },
      );
    }

    if (status) {
      qb.andWhere('user.blocked = :blocked', {
        blocked: status === CustomerStatusFilter.BLOCKED,
      });
    }

    if (distributorId) {
      qb.andWhere(clienteDeLaDistribuidora('customer.userId'), {
        distributorId,
      });
    }

    return qb.getManyAndCount();
  }

  /**
   * Ownership (anti-IDOR): si `requesterUserId` viene (rol NO admin), el cliente
   * debe ser el del que pide; si no, 403. Los admin pasan undefined y saltan.
   */
  private assertOwnership(
    customerUserId: string,
    requesterUserId?: string | null,
  ): void {
    if (requesterUserId && customerUserId !== requesterUserId) {
      throw new ForbiddenException(
        'No autorizado a acceder a datos de otro cliente',
      );
    }
  }

  /**
   * El cliente que hace un pedido: si tiene perfil activo y su correo (para
   * la pasarela de pago). `null` si no es cliente.
   */
  async buscarComprador(userId: string): Promise<{
    email: string | null;
    fullName: string | null;
    phoneNumber: string | null;
  } | null> {
    const customer = await this.customerRepository.findOne({
      where: { userId },
      relations: ['user'],
    });
    return customer
      ? {
          email: customer.user.email ?? null,
          fullName: customer.user.fullName ?? null,
          phoneNumber: customer.user.phoneNumber ?? null,
        }
      : null;
  }

  /**
   * Aislamiento entre distribuidoras: con una distribuidora en contexto, el
   * cliente tiene que ser suyo (`clienteDeLaDistribuidora`: le compró o lo dio de alta). Si no, 404,
   * como si no existiera.
   */
  async assertDeLaDistribuidora(
    por: { customer_id: string } | { user_id: string },
    distributorId: string,
  ): Promise<void> {
    const [columna, valor] =
      'customer_id' in por
        ? ['customer.customerId', por.customer_id]
        : ['customer.userId', por.user_id];
    const existe = await this.customerRepository
      .createQueryBuilder('customer')
      .where(`${columna} = :valor`, { valor })
      .andWhere(clienteDeLaDistribuidora('customer.userId'), { distributorId })
      .getExists();
    if (!existe) {
      throw new NotFoundException('Cliente no encontrado');
    }
  }

  async findOne(
    id: string,
    requesterUserId?: string | null,
  ): Promise<Customer> {
    const customer = await this.customerRepository.findOne({
      where: { customerId: id },
      relations: [
        'user',
        'user.role',
        'user.addresses',
        'declaredCylinderType',
      ],
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    this.assertOwnership(customer.userId, requesterUserId);
    return customer;
  }

  async findOneByUserId(
    userId: string,
    requesterUserId?: string | null,
  ): Promise<Customer> {
    this.assertOwnership(userId, requesterUserId);
    const customer = await this.customerRepository.findOne({
      where: { userId },
      relations: [
        'user',
        'user.role',
        'user.addresses',
        'declaredCylinderType',
      ],
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return customer;
  }

  async findOneByEmail(email: string): Promise<Customer> {
    const customer = await this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.addresses', 'addresses')
      .leftJoinAndSelect(
        'customer.declaredCylinderType',
        'declaredCylinderType',
      )
      .where('user.email = :email', { email })
      .getOne();

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return customer;
  }

  async update(
    id: string,
    updateCustomerDto: UpdateCustomerDto,
    requesterUserId?: string | null,
  ): Promise<Customer> {
    // Ownership: valida que el cliente sea del que pide (si no es admin).
    await this.findOne(id, requesterUserId);

    // La ubicación llega como "lat,lng" y se guarda como punto.
    // El resto campo por campo: el cuerpo va en snake_case y la entidad en
    // camelCase, y volcarlo entero perdería `notification_token` en silencio.
    const { lat_lang, notification_token } = updateCustomerDto;
    const customer = await this.customerRepository.preload({
      customerId: id,
      ...sinIndefinidos({ notificationToken: notification_token }),
      ...(lat_lang !== undefined && { location: puntoDesdeLatLng(lat_lang) }),
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    await this.customerRepository.save(customer);
    return await this.findOne(id);
  }

  async remove(id: string): Promise<MessageResponseDto> {
    await this.findOne(id);
    // `softRemove` y no `softDelete`: sólo así TypeORM anuncia la baja y queda
    // en la auditoría de datos. Va sólo con el id para no arrastrar relaciones.
    await this.customerRepository.softRemove(
      this.customerRepository.create({ customerId: id }),
    );
    return MessageResponseDto.of('Cliente dado de baja');
  }

  async updateLocation(
    id: string,
    latLng: string,
    requesterUserId?: string | null,
  ): Promise<Customer> {
    const customer = await this.findOne(id, requesterUserId);
    customer.location = puntoDesdeLatLng(latLng);
    await this.customerRepository.save(customer);
    return customer;
  }

  /**
   * Delega en el traductor compartido. Antes cada servicio tenia su propia
   * copia: contemplaban uno o dos codigos de Postgres y convertian todo lo
   * demas en un 500 sin registrar la causa, asi que el mensaje mandaba a
   * mirar unos logs donde el error no estaba.
   */
  private handleDBExceptions(error: unknown): never {
    return traducirErrorDeBase(error, this.logger, 'clientes');
  }
}
