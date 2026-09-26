import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets, EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
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

/** Lo que el alta guarda en la fila del usuario. */
export interface DatosDeUsuarioNuevo {
  email: string;
  full_name: string;
  phone_number: string;
  selfie?: string;
  firebase_uid: string;
  role_id: string;
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
  ) {}

  /**
   * El correo y el teléfono tienen que estar libres, también entre los dados
   * de baja (la restricción única los sigue contando). Se controla antes de
   * crear la cuenta en Firebase: un duplicado no llega a crear nada.
   */
  async assertDisponible(email: string, phoneNumber: string): Promise<void> {
    const existente = await this.userRepository.findOne({
      where: [{ email }, { phone_number: phoneNumber }],
      withDeleted: true,
      select: { user_id: true },
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
        email_verified: false,
        phone_verified: false,
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
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ): Promise<{ users: User[]; maxUsers: number }> {
    const { limit = 10, offset = 0, term } = paginationDto;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.customer', 'customer')
      .leftJoinAndSelect('user.delivery', 'delivery')
      .take(limit)
      .skip(offset);

    if (distributorId) {
      queryBuilder.andWhere(usuarioDeLaDistribuidora('user.user_id'), {
        distributorId,
      });
    }

    if (term) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('user.email ILIKE :term', { term: `%${term}%` })
            .orWhere('user.full_name ILIKE :term', { term: `%${term}%` })
            .orWhere('user.phone_number ILIKE :term', { term: `%${term}%` });
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
      .where('user.user_id = :userId', { userId })
      .andWhere(usuarioDeLaDistribuidora('user.user_id'), { distributorId })
      .getCount();
    return cantidad > 0;
  }

  /** El usuario sin relaciones, o null. Para confirmar que existe. */
  findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { user_id: id } });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { user_id: id },
      relations: ['role', 'customer', 'delivery', 'cars', 'addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    return user;
  }

  /**
   * El usuario con su rol y nada más, o null si no existe o está dado de baja.
   * Para el handshake de los sockets: `findOneByEmail` trae seis relaciones,
   * que en cada conexión es caro y no se usa.
   */
  findOneWithRoleByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email },
      relations: ['role'],
    });
  }

  async findOneByEmail(email: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { email },
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
      where: { phone_number: phoneNumber },
      relations: ['role', 'customer', 'delivery', 'addresses'],
    });
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const { password, ...campos } = updateUserDto;
    const user = await this.userRepository.preload({
      user_id: id,
      ...campos,
    });

    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    // La contraseña vive en el proveedor de identidad, no en la base: antes se
    // descartaba en silencio y el panel informaba un cambio que no ocurría
    // (H-75).
    if (password) {
      if (!user.firebase_uid) {
        throw new ConflictException(
          'El usuario no tiene cuenta de acceso: no se le puede cambiar la contraseña',
        );
      }
      await this.cambiarContraseña(user.firebase_uid, password);
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
      { user_id: id },
      { email, email_verified: false },
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
      where: { user_id: id },
      relations: ['role', 'delivery', 'admins'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }
    return {
      rol: user.role?.type,
      distributorId:
        user.delivery?.distributor_id ??
        user.admins?.[0]?.distributor_id ??
        null,
    };
  }

  /**
   * Baja lógica (H-74): el usuario, su perfil de cliente o chofer, sus
   * vehículos y sus direcciones quedan con `deletedAt` y dejan de aparecer.
   * Nada se borra: los pedidos, pagos y calificaciones siguen apuntando a él
   * y la auditoría conserva quién era. Su cuenta de Firebase se deshabilita
   * (no se borra): no puede volver a entrar, y el correo sigue ocupado.
   */
  async remove(id: string): Promise<MessageResponseDto> {
    const user = await this.userRepository.findOne({
      where: { user_id: id },
      relations: ['customer', 'delivery', 'cars', 'addresses'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    await this.userRepository.softRemove(user);

    // Sin fila vigente el acceso ya lo rechaza; deshabilitar la cuenta es la
    // segunda barrera. Si Firebase falla, la baja igual quedó hecha.
    if (user.firebase_uid) {
      try {
        await this.firebaseAuth.updateUser(user.firebase_uid, {
          disabled: true,
        });
      } catch (error) {
        this.logger.error(
          `Usuario ${id} dado de baja, pero no se pudo deshabilitar su cuenta de Firebase: ${errorMessage(error)}`,
        );
      }
    }

    return MessageResponseDto.of('Usuario dado de baja');
  }

  /**
   * Si el correo y el teléfono ya están en uso, cada uno por separado. Antes
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
        ? this.userRepository.exists({ where: { email } })
        : Promise.resolve(false),
      phoneNumber
        ? this.userRepository.exists({ where: { phone_number: phoneNumber } })
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

    user.email_verified = true;
    const updatedUser = await this.userRepository.save(user);

    return updatedUser;
  }

  async verifyEmailByAddress(email: string): Promise<User> {
    const user = await this.findOneByEmail(email);
    return await this.verifyEmail(user.user_id);
  }

  async findOneByFirebaseUid(firebaseUid: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { firebase_uid: firebaseUid },
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
    const user = await this.userRepository.findOne({ where: { user_id: id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    user.blocked = shouldBlock;
    await this.userRepository.save(user);

    return {
      id: user.user_id,
      email: user.email ?? null,
      isBlocked: user.blocked,
      message: user.blocked
        ? 'Usuario BLOQUEADO 🚫'
        : 'Usuario DESBLOQUEADO ✅',
    };
  }
}
