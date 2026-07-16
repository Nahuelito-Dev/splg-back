import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { ConfigService } from '@nestjs/config';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';

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

  async create(createUserDto: CreateUserDto): Promise<User> {
    try {
      const user = this.userRepository.create(createUserDto);
      const savedUser = await this.userRepository.save(user);

      if (!savedUser) {
        throw new InternalServerErrorException('User could not be created');
      }

      return savedUser;
    } catch (error) {
      this.handleDBExceptions(error);
      throw new InternalServerErrorException('User creation failed');
    }
  }

  /**
   * Best-effort, delega el mapeo de errores en `FirebaseAuthPort` (antes
   * duplicado acá, en `CustomersService` y en `DeliveryService`; ver punto 4
   * de `docs/ARQUITECTURA-REVIEW.md`).
   */
  private async cleanupFirebaseUser(email: string) {
    await this.firebaseAuth.deleteUserByEmailSafe(email, this.logger);
  }

  /**
   * Método PÚBLICO (lo usan `admin-registration.helper.ts` y
   * `user-registration.helper.ts`). Delega el create + mapeo de errores en
   * `FirebaseAuthPort.createUserSafe` (antes duplicado acá, en
   * `CustomersService` y en `DeliveryService`).
   */
  async createFirebaseUser(createUserDto: CreateUserDto) {
    return this.firebaseAuth.createUserSafe(createUserDto);
  }

  async findFbUserByEmail(email: string): Promise<boolean> {
    try {
      await this.firebaseAuth.getUserByEmail(email);
      return true;
    } catch (error) {
      // CORRECCIÓN AQUÍ: Casteamos a 'any' para acceder a .code
      const firebaseError = error as any;

      if (firebaseError.code === 'auth/user-not-found') {
        return false;
      }

      // Es buena práctica loguear el error real antes de lanzar la excepción genérica
      this.logger.error(firebaseError);
      throw new InternalServerErrorException('Error al consultar Firebase');
    }
  }

  async findAll(paginationDto: PaginationDto & { term?: string }) {
    const { limit = 10, offset = 0, term } = paginationDto;

    // Usamos CreateQueryBuilder para búsquedas flexibles
    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.customer', 'customer')
      .leftJoinAndSelect('user.delivery', 'delivery')
      .take(limit)
      .skip(offset);

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
  async findOne(id: string) {
    const user = await this.userRepository.findOne({
      where: { user_id: id },
      relations: ['role', 'customer', 'delivery', 'cars', 'addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
    }

    return user;
  }

  async findOneByEmail(email: string) {
    const user = await this.userRepository.findOne({
      where: { email },
      relations: ['role', 'customer', 'delivery', 'cars', 'addresses', 'admins'],
    });

    if (!user) {
      throw new NotFoundException(`User with email: ${email} not found`);
    }

    return user;
  }

  async findOneByPhone(phoneNumber: string) {
    const user = await this.userRepository.findOne({
      where: { phone_number: phoneNumber },
      relations: ['role', 'customer', 'delivery', 'cars', 'addresses'],
    });

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    const user = await this.userRepository.preload({
      user_id: id,
      ...updateUserDto,
    });

    if (!user) {
      throw new NotFoundException(`User with ID: ${id} not found`);
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
      this.handleDBExceptions(error);
    }
  }

  async remove(id: string) {
    // 1. Buscamos el usuario antes de borrarlo para tener su email
    const user = await this.findOne(id);

    // 2. Borrar de Firebase (Si tiene email asociado)
    if (user.email) {
      await this.cleanupFirebaseUser(user.email);
    }

    // 3. Borrado FÍSICO de la base de datos (DELETE real)
    // Nota: Esto fallará si hay relaciones (FK) sin "ON DELETE CASCADE".
    // Asegúrate de que tus entidades Customer/Delivery tengan onDelete: 'CASCADE'
    await this.userRepository.delete({ user_id: id });

    return { message: 'Usuario eliminado permanentemente de DB y Firebase' };
  }

  async checkUserExists(email?: string, phoneNumber?: string) {
    const conditions: any[] = [];

    if (email) conditions.push({ email });
    if (phoneNumber) conditions.push({ phone_number: phoneNumber });

    if (conditions.length === 0) {
      return { exists: false };
    }

    const user = await this.userRepository.findOne({
      where: conditions,
    });

    const result = {
      exists: !!user,
      email: email ? !!user?.email : false,
      phoneNumber: phoneNumber ? !!user?.phone_number : false,
    };

    return result;
  }

  private handleDBExceptions(error: any) {
    if (error.code === '23505') {
      throw new BadRequestException('Duplicate entry', error.detail);
    }
    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
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

  async toggleBlockUser(id: string, shouldBlock: boolean) {
    const user = await this.userRepository.findOne({ where: { user_id: id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    user.blocked = shouldBlock;
    await this.userRepository.save(user);

    return {
      id: user.user_id,
      email: user.email,
      isBlocked: user.blocked,
      message: user.blocked
        ? 'Usuario BLOQUEADO 🚫'
        : 'Usuario DESBLOQUEADO ✅',
    };
  }
}
