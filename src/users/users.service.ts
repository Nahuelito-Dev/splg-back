import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { User } from './entities/user.entity';
import {
  ChoferDadoDeBajaEvent,
  EVENTO_CHOFER_DADO_DE_BAJA,
} from '../delivery/events/chofer-dado-de-baja.event';
import { UpdateUserDto } from './dto/update-user.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { QueryUsersDto } from './dto/query-users.dto';
import { ConfigService } from '@nestjs/config';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';

import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { errorMessage } from '../common/errors/error-message';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import {
  BloqueoDeUsuarioDto,
  UsuarioExisteDto,
} from './dto/usuarios-response.dto';
import { usuarioDeLaDistribuidora } from '../common/tenancy/pertenencia';
import { emailIgualA, normalizarEmail } from '../common/utils/email.util';
import { bloquearChoferes } from '../common/locks/chofer-lock';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { RedisService } from '../redis/redis.service';

/** Intentos para deshabilitar la cuenta de Firebase tras una baja, y la espera entre uno y otro. */
const INTENTOS_DESHABILITAR_CUENTA = 3;
const ESPERA_ENTRE_INTENTOS_MS = 200;

/** Lo que el alta guarda en la fila del usuario. */
export interface DatosDeUsuarioNuevo {
  email: string;
  fullName: string;
  phoneNumber: string;
  selfie?: string;
  firebaseUid: string;
  roleId: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly firebaseAuth: FirebaseAuthPort,
    private readonly eventos: EventEmitter2,
    private readonly orderLookup: OrderLookupService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * El correo y el teléfono tienen que estar libres, también entre los dados
   * de baja (la restricción única los sigue contando). Se controla antes de
   * crear la cuenta en Firebase: un duplicado no llega a crear nada.
   */
  async assertDisponible(email: string, phoneNumber: string): Promise<void> {
    const existente = await this.userRepository.findOne({
      where: [{ email: emailIgualA(email) }, { phoneNumber }],
      withDeleted: true,
      select: { userId: true },
    });
    if (existente) {
      throw new ConflictException('Email o teléfono ya en uso');
    }
  }

  /** La fila del usuario, dentro de la transacción del alta. */
  crearEnTransaccion(
    manager: EntityManager,
    datos: DatosDeUsuarioNuevo,
  ): Promise<User> {
    const repo = manager.getRepository(User);
    return repo.save(
      repo.create({
        ...datos,
        emailVerified: false,
        phoneVerified: false,
        blocked: false,
      }),
    );
  }

  /**
   * Lista usuarios. Con `distributorId` (admin de empresa, o super admin con
   * "ver como") sólo los de esa distribuidora: sus choferes, sus admins y los
   * clientes que le compraron (H-66). Sin él, todos.
   */
  async findAll(
    paginationDto: QueryUsersDto,
    distributorId?: string | null,
  ): Promise<{ users: User[]; maxUsers: number }> {
    const { limit = 10, offset = 0, term, role } = paginationDto;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.customer', 'customer')
      .leftJoinAndSelect('user.delivery', 'delivery')
      .take(limit)
      .skip(offset);

    if (distributorId) {
      queryBuilder.andWhere(usuarioDeLaDistribuidora('user.userId'), {
        distributorId,
      });
    }

    if (role) {
      queryBuilder.andWhere('role.type = :role', { role });
    }

    if (term) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('user.email ILIKE :term', { term: `%${term}%` })
            .orWhere('user.fullName ILIKE :term', { term: `%${term}%` })
            .orWhere('user.phoneNumber ILIKE :term', { term: `%${term}%` });
        }),
      );
    }

    const [users, total] = await queryBuilder.getManyAndCount();

    return {
      users,
      maxUsers: total,
    };
  }

  /**
   * Si el usuario es de la distribuidora: chofer o admin de ella, o cliente
   * que le compró. Un super admin no es de ninguna.
   */
  async perteneceA(userId: string, distributorId: string): Promise<boolean> {
    const cantidad = await this.userRepository
      .createQueryBuilder('user')
      .where('user.userId = :userId', { userId })
      .andWhere(usuarioDeLaDistribuidora('user.userId'), { distributorId })
      .getCount();
    return cantidad > 0;
  }

  /** El usuario sin relaciones, o null. Para confirmar que existe. */
  findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { userId: id } });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { userId: id },
      relations: ['role', 'customer', 'delivery', 'cars', 'addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    return user;
  }

  /**
   * El usuario con su rol y la distribuidora de su perfil de staff (si
   * aplica), nada más. Para el handshake de los sockets: `findOneByEmail`
   * trae seis relaciones, varias colecciones grandes (`cars`, `addresses`),
   * que en cada conexión es caro y no se usa. `admins`/`delivery` son 1-a-uno
   * o 1-a-pocos: las necesita `SocketIdentityService` para resolver la
   * distribuidora del staff y armar la sala del admin por tenant.
   */
  findOneWithRoleByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email: emailIgualA(email) },
      relations: ['role', 'admins', 'delivery'],
    });
  }

  async findOneByEmail(email: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { email: emailIgualA(email) },
      relations: [
        'role',
        'customer',
        'delivery',
        'cars',
        'addresses',
        'admins',
      ],
    });

    if (!user) {
      throw new NotFoundException(`User with email: ${email} not found`);
    }

    return user;
  }

  findOneByPhone(phoneNumber: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { phoneNumber },
      relations: ['role', 'customer', 'delivery', 'addresses'],
    });
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const { password } = updateUserDto;
    // Campo por campo: el cuerpo va en snake_case y la entidad en camelCase.
    const user = await this.userRepository.preload({
      userId: id,
      ...sinIndefinidos({
        fullName: updateUserDto.full_name,
        phoneNumber: updateUserDto.phone_number,
        selfie: updateUserDto.selfie,
        blocked: updateUserDto.blocked,
      }),
    });

    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    // La contraseña vive en el proveedor de identidad, no en la base: antes se
    // descartaba en silencio y el panel informaba un cambio que no ocurría
    // (H-75).
    if (password) {
      if (!user.firebaseUid) {
        throw new ConflictException(
          'El usuario no tiene cuenta de acceso: no se le puede cambiar la contraseña',
        );
      }
      await this.cambiarContraseña(user.firebaseUid, password);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.manager.save(user);
      await queryRunner.commitTransaction();
      await queryRunner.release();

      return user;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
      return this.handleDBExceptions(error);
    }
  }

  /**
   * El correo nuevo de un usuario, que vuelve a quedar sin verificar. Sólo
   * para `EmailService.changeEmail`, que antes lo cambió en el proveedor de
   * identidad con el token de la persona: nunca por `PATCH /users/:id`.
   */
  async cambiarEmail(id: string, email: string): Promise<void> {
    await this.userRepository.update(
      { userId: id },
      { email: normalizarEmail(email), emailVerified: false },
    );
  }

  private async cambiarContraseña(uid: string, password: string) {
    try {
      await this.firebaseAuth.updateUser(uid, { password });
    } catch (error) {
      this.logger.error(`No se pudo cambiar la contraseña de ${uid}`, error);
      throw new BadRequestException('No se pudo cambiar la contraseña');
    }
  }

  /**
   * El rol del usuario y la distribuidora de su perfil, o null si no tiene
   * (clientes y super administradores). Para decidir si un admin de empresa
   * puede modificarlo.
   */
  async findAlcance(
    id: string,
  ): Promise<{ rol: string | undefined; distributorId: string | null }> {
    const user = await this.userRepository.findOne({
      where: { userId: id },
      relations: ['role', 'delivery', 'admins'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }
    return {
      rol: user.role?.type,
      distributorId:
        user.delivery?.distributorId ?? user.admins?.[0]?.distributorId ?? null,
    };
  }

  /**
   * Baja lógica (H-74): el usuario, su perfil de cliente o chofer y sus
   * direcciones quedan con `deletedAt` y dejan de aparecer. Nada se borra:
   * los pedidos, pagos y calificaciones siguen apuntando a él y la auditoría
   * conserva quién era. Su cuenta de Firebase se deshabilita (no se borra):
   * no puede volver a entrar, y el correo sigue ocupado.
   *
   * Sus vehículos NO se dan de baja (revisión de vehículo en uso): la flota
   * es de la distribuidora, no del usuario (`cars` ya no tiene `cascade` en
   * la entidad). Si tenía perfil de chofer: se rechaza con 409 mientras tenga
   * pedidos aceptados o en camino (quedarían sin quien los entregue), y se
   * libera el vehículo que tenía en uso DENTRO de la misma transacción, por
   * el evento `chofer.dado-de-baja` que escucha `VehicleReleaseOnBajaListener`
   * (así `users` no depende de `car`, CONVENCIONES §4): si la liberación
   * falla, la baja se revierte.
   */
  async remove(id: string): Promise<MessageResponseDto> {
    const user = await this.userRepository.findOne({
      where: { userId: id },
      relations: ['customer', 'delivery', 'addresses'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    await this.dataSource.transaction(async (manager) => {
      if (user.delivery) {
        // Con el chofer bloqueado: una aceptación o asignación en curso
        // termina antes del conteo, y la que llega después ve la baja.
        await bloquearChoferes(manager, [user.delivery.deliveryId]);
        const pedidos = await this.orderLookup.countActiveByDelivery(
          user.delivery.deliveryId,
          manager,
        );
        if (pedidos > 0) {
          throw new ConflictException(
            `El chofer tiene ${pedidos} pedido(s) en curso: cancelalos o reasignalos antes de darlo de baja`,
          );
        }
      }

      await manager.softRemove(user);

      if (user.delivery) {
        await this.eventos.emitAsync(
          EVENTO_CHOFER_DADO_DE_BAJA,
          new ChoferDadoDeBajaEvent(user.delivery.deliveryId, manager),
        );
      }
    });

    // Recién con la baja confirmada sale del radar de despacho. Si Redis
    // falla la baja ya está hecha: se registra, no se revierte.
    if (user.delivery) {
      try {
        await this.redisService.removeDriver(user.userId);
      } catch (error) {
        this.logger.error(
          `Chofer ${user.delivery.deliveryId} dado de baja, pero no se pudo sacar del radar de despacho: ${errorMessage(error)}`,
        );
      }
    }

    // Sin fila vigente el acceso ya lo rechaza; deshabilitar la cuenta es la
    // segunda barrera. Si Firebase falla la baja igual quedó hecha: se
    // reintenta y, si no hay caso, queda registrado con qué cuenta hay que
    // deshabilitar a mano.
    if (user.firebaseUid) {
      await this.deshabilitarCuenta(id, user.firebaseUid);
    }

    return MessageResponseDto.of('Usuario dado de baja');
  }

  private async deshabilitarCuenta(
    userId: string,
    firebaseUid: string,
  ): Promise<void> {
    for (let intento = 1; intento <= INTENTOS_DESHABILITAR_CUENTA; intento++) {
      try {
        await this.firebaseAuth.updateUser(firebaseUid, { disabled: true });
        return;
      } catch (error) {
        if (intento === INTENTOS_DESHABILITAR_CUENTA) {
          this.logger.error(
            `Usuario ${userId} dado de baja, pero su cuenta de Firebase ${firebaseUid} sigue HABILITADA tras ${intento} intentos: deshabilitarla a mano. Causa: ${errorMessage(error)}`,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, ESPERA_ENTRE_INTENTOS_MS));
      }
    }
  }

  /**
   * Si el correo y el teléfono ya están en uso, cada uno por separado. Cuenta
   * también a los dados de baja: es la misma regla de `assertDisponible`, así
   * que "libre" acá nunca termina en un 409 en el alta. Antes
   * se buscaba un usuario con cualquiera de los dos y se marcaba el correo
   * como usado si ese usuario tenía correo, aunque la coincidencia fuera por
   * el teléfono.
   */
  async checkUserExists(
    email?: string,
    phoneNumber?: string,
  ): Promise<UsuarioExisteDto> {
    const [emailUsado, telefonoUsado] = await Promise.all([
      email
        ? this.userRepository.exists({
            where: { email: emailIgualA(email) },
            withDeleted: true,
          })
        : Promise.resolve(false),
      phoneNumber
        ? this.userRepository.exists({
            where: { phoneNumber },
            withDeleted: true,
          })
        : Promise.resolve(false),
    ]);
    return {
      exists: emailUsado || telefonoUsado,
      email: emailUsado,
      phoneNumber: telefonoUsado,
    };
  }

  /**
   * Delega en el traductor compartido. Antes esto contemplaba sólo los
   * duplicados y convertía todo lo demás en un 500 sin registrar la causa:
   * crear un usuario con un rol inexistente daba "Unexpected error, check
   * server logs" y en los logs no había nada.
   */
  private handleDBExceptions(error: unknown): never {
    return traducirErrorDeBase(error, this.logger, 'usuarios');
  }

  async verifyEmail(userId: string): Promise<User> {
    const user = await this.findOne(userId);

    user.emailVerified = true;
    const updatedUser = await this.userRepository.save(user);

    return updatedUser;
  }

  async verifyEmailByAddress(email: string): Promise<User> {
    const user = await this.findOneByEmail(email);
    return await this.verifyEmail(user.userId);
  }

  async findOneByFirebaseUid(firebaseUid: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { firebaseUid },
      relations: ['role', 'customer', 'delivery', 'cars'],
    });

    if (!user) {
      throw new NotFoundException(
        `User with Firebase UID: ${firebaseUid} not found`,
      );
    }

    return user;
  }

  async toggleBlockUser(
    id: string,
    shouldBlock: boolean,
  ): Promise<BloqueoDeUsuarioDto> {
    const user = await this.userRepository.findOne({ where: { userId: id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    user.blocked = shouldBlock;
    await this.userRepository.save(user);

    return {
      id: user.userId,
      email: user.email ?? null,
      isBlocked: user.blocked,
      message: user.blocked
        ? 'Usuario BLOQUEADO 🚫'
        : 'Usuario DESBLOQUEADO ✅',
    };
  }
}
