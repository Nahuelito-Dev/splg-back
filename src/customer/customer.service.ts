import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { puntoDesdeLatLng } from '../common/geo/punto';
import { clienteDeLaDistribuidora } from '../common/tenancy/pertenencia';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';

/** Lo que el alta guarda en el perfil de un cliente nuevo. */
export interface PerfilDeClienteNuevo {
  lat_lang?: string;
  notification_token?: string;
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
      }),
    );
  }

  /**
   * Lista clientes. Los clientes son GLOBALES (uno puede pedir a varias
   * distribuidoras), así que el scoping por tenant no es una columna sino una
   * relación: si viene `distributorId` (admin de empresa, o super_admin con
   * "ver como"), devuelve solo los clientes que tienen al menos un pedido con
   * esa distribuidora. Sin él (super_admin cross-tenant) devuelve todos.
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
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ): Promise<Customer[]> {
    const { limit = 10, offset = 0 } = paginationDto;

    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.addresses', 'addresses')
      .take(limit)
      .skip(offset);

    if (distributorId) {
      qb.andWhere(clienteDeLaDistribuidora('customer.userId'), {
        distributorId,
      });
    }

    return qb.getMany();
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
  async buscarComprador(
    userId: string,
  ): Promise<{ email: string | null } | null> {
    const customer = await this.customerRepository.findOne({
      where: { userId },
      relations: ['user'],
    });
    return customer ? { email: customer.user.email ?? null } : null;
  }

  /**
   * Aislamiento entre distribuidoras: con una distribuidora en contexto, el
   * cliente tiene que haberle comprado (`clienteDeLaDistribuidora`). Si no, 404,
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
      throw new NotFoundException(`Customer with ID: ${valor} not found`);
    }
  }

  async findOne(
    id: string,
    requesterUserId?: string | null,
  ): Promise<Customer> {
    const customer = await this.customerRepository.findOne({
      where: { customerId: id },
      relations: ['user', 'user.role', 'user.addresses'],
    });

    if (!customer) {
      throw new NotFoundException(`Customer with ID: ${id} not found`);
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
      relations: ['user', 'user.role', 'user.addresses'],
    });

    if (!customer) {
      throw new NotFoundException(`Customer for user ID: ${userId} not found`);
    }

    return customer;
  }

  async findOneByEmail(email: string): Promise<Customer> {
    const customer = await this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.addresses', 'addresses')
      .where('user.email = :email', { email })
      .getOne();

    if (!customer) {
      throw new NotFoundException(`Customer with email: ${email} not found`);
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
      throw new NotFoundException(`Customer with ID: ${id} not found`);
    }

    await this.customerRepository.save(customer);
    return await this.findOne(id);
  }

  async remove(id: string): Promise<MessageResponseDto> {
    await this.findOne(id);
    await this.customerRepository.softDelete({ customerId: id });
    return MessageResponseDto.of('Customer deleted successfully');
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
