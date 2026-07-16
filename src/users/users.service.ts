import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { ConfigService } from '@nestjs/config';
import * as firebase from 'firebase-admin';
import { serviceAccount } from '../auth/service-account';
import { CompleteCustomerRegistrationDto } from 'src/customer/dto/complete-customer-registration.dto';
import { Customer } from 'src/customer/entities/customer.entity';
import { Role } from 'src/role/entities/role.entity';
import { CreateDeliveryDto } from 'src/delivery/dto/create-delivery.dto';
import { Delivery } from 'src/delivery/entities/delivery.entity';
import { EmailService } from 'src/email/email.service';

@Injectable()
export class UsersService {
  private adminApp: firebase.app.App;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,

    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,

    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,

    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
  ) {
    this.adminApp = firebase.initializeApp(
      {
        credential: firebase.credential.cert(serviceAccount),
      },
      'users',
    );
  }

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

  async createCustomerWithUser(
    createCustomerDto: CompleteCustomerRegistrationDto,
  ) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const existingUser = await this.userRepository.findOne({
        where: { email: createCustomerDto.email },
      });

      if (existingUser) {
        throw new BadRequestException('User with this email already exists');
      }

      const firebaseUser = await this.createFirebaseUser({
        email: createCustomerDto.email,
        password: createCustomerDto.password,
        full_name: createCustomerDto.full_name,
        phone_number: createCustomerDto.phone_number,
      });

      const customerRole = await this.roleRepository.findOne({
        where: { type: 'customer' },
      });

      if (!customerRole) {
        throw new InternalServerErrorException('Customer role not found');
      }

      const user = this.userRepository.create({
        email: createCustomerDto.email,
        full_name: createCustomerDto.full_name,
        phone_number: createCustomerDto.phone_number,
        firebase_uid: firebaseUser.uid,
        role_id: customerRole.role_id,
        email_verified: false,
        phone_verified: false,
        blocked: false,
      });

      const savedUser = await queryRunner.manager.save(user);

      const customer = this.customerRepository.create({
        user_id: savedUser.user_id,
        notification_token: createCustomerDto.notification_token,
        lat_lang: createCustomerDto.lat_lang,
        validated: 'false',
      });

      await queryRunner.manager.save(customer);
      await queryRunner.commitTransaction();

      try {
        await this.emailService.sendWelcomeEmail?.(createCustomerDto.email);
      } catch (e) {}

      const result = await this.userRepository.findOne({
        where: { user_id: savedUser.user_id },
        relations: ['customer', 'role'],
      });

      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (createCustomerDto.email) {
        await this.cleanupFirebaseUser(createCustomerDto.email);
      }

      this.handleDBExceptions(error);
    } finally {
      await queryRunner.release();
    }
  }

  async createDeliveryWithUser(createDeliveryDto: CreateDeliveryDto) {
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

      const firebaseUser = await this.createFirebaseUser({
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
        await this.cleanupFirebaseUser(createDeliveryDto.email);
      }

      this.handleDBExceptions(error);
    } finally {
      await queryRunner.release();
    }
  }

  private async cleanupFirebaseUser(email: string) {
    try {
      const auth = this.adminApp.auth();
      const userRecord = await auth.getUserByEmail(email);
      await auth.deleteUser(userRecord.uid);
    } catch (error) {
      // fail silently
    }
  }

  private async getDefaultCustomerRoleId(): Promise<string> {
    const roleRepository = this.dataSource.getRepository(Role);
    const defaultRole = await roleRepository.findOne({
      where: { type: 'customer' },
    });

    if (!defaultRole) {
      throw new InternalServerErrorException('Default customer role not found');
    }

    return defaultRole.role_id;
  }

  async createFirebaseUser(createUserDto: CreateUserDto) {
    const auth = this.adminApp.auth();
    try {
      const userRecord = await auth.createUser({
        email: createUserDto.email,
        password: createUserDto.password,
        displayName: createUserDto.full_name,
        phoneNumber: createUserDto.phone_number,
      });

      return userRecord;
    } catch (error) {
      // CORRECCIÓN AQUÍ: Casteamos a 'any' para acceder a .code y .message
      const firebaseError = error as any;

      let errorMessage = `Error creating Firebase user: ${firebaseError.message}`;

      if (firebaseError.code === 'auth/weak-password') {
        errorMessage = 'Password is too weak. Use at least 6 characters.';
      } else if (firebaseError.code === 'auth/email-already-exists') {
        errorMessage = 'Email already exists in Firebase.';
      } else if (firebaseError.code === 'auth/invalid-email') {
        errorMessage = 'Invalid email format.';
      } else if (firebaseError.code === 'auth/invalid-phone-number') {
        errorMessage =
          'Invalid phone number format. Use E.164 format: +1234567890';
      }

      throw new BadRequestException(errorMessage);
    }
  }

  async findFbUserByEmail(email: string): Promise<boolean> {
    const auth = this.adminApp.auth();
    try {
      await auth.getUserByEmail(email);
      return true;
    } catch (error) {
      // CORRECCIÓN AQUÍ: Casteamos a 'any' para acceder a .code
      const firebaseError = error as any;

      if (firebaseError.code === 'auth/user-not-found') {
        return false;
      }

      // Es buena práctica loguear el error real antes de lanzar la excepción genérica
      console.error(firebaseError);
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

  async findOneByPhonee(phone: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { phone_number: phone },
      relations: ['role'],
    });
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
