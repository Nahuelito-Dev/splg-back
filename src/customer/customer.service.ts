import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { User } from '../users/entities/user.entity';
import { Role } from '../role/entities/role.entity';
import { Order } from '../order/entities/order.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CompleteCustomerRegistrationDto } from './dto/complete-customer-registration.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { EmailService } from '../email/email.service';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger('CustomersService');

  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    private readonly dataSource: DataSource,
    private readonly firebaseAuth: FirebaseAuthPort,
    private readonly emailService: EmailService,
  ) { }

  /**
   * Registro completo: User + Customer + Firebase, en una transacción.
   * Movido acá desde `UsersService.createCustomerWithUser` (P2-3) para que
   * `UsersService` deje de conocer entidades de otros dominios (cortar el
   * ciclo de forwardRef users↔email).
   */
  async registerWithUser(dto: CompleteCustomerRegistrationDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const existingUser = await this.userRepository.findOne({
        where: { email: dto.email },
      });

      if (existingUser) {
        throw new BadRequestException('User with this email already exists');
      }

      const firebaseUser = await this.createFirebaseUser({
        email: dto.email,
        password: dto.password,
        full_name: dto.full_name,
        phone_number: dto.phone_number,
      });

      const customerRole = await this.roleRepository.findOne({
        where: { type: 'customer' },
      });

      if (!customerRole) {
        throw new InternalServerErrorException('Customer role not found');
      }

      const user = this.userRepository.create({
        email: dto.email,
        full_name: dto.full_name,
        phone_number: dto.phone_number,
        firebase_uid: firebaseUser.uid,
        role_id: customerRole.role_id,
        email_verified: false,
        phone_verified: false,
        blocked: false,
      });

      const savedUser = await queryRunner.manager.save(user);

      const customer = this.customerRepository.create({
        user_id: savedUser.user_id,
        notification_token: dto.notification_token,
        lat_lang: dto.lat_lang,
        validated: 'false',
      });

      await queryRunner.manager.save(customer);
      await queryRunner.commitTransaction();

      try {
        await this.emailService.sendWelcomeEmail?.(dto.email);
      } catch (e) {
        // Best-effort: el registro del customer NO debe fallar si el email
        // de bienvenida no se pudo enviar. Solo dejamos rastro.
        this.logger.warn(
          `No se pudo enviar el email de bienvenida a ${dto.email}: ${e instanceof Error ? e.message : e}`,
        );
      }

      const result = await this.userRepository.findOne({
        where: { user_id: savedUser.user_id },
        relations: ['customer', 'role'],
      });

      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (dto.email) {
        await this.cleanupFirebaseUser(dto.email);
      }

      this.handleDBExceptions(error);
    } finally {
      await queryRunner.release();
    }
  }

  private async createFirebaseUser(props: {
    email: string;
    password: string;
    full_name: string;
    phone_number: string;
  }) {
    try {
      const userRecord = await this.firebaseAuth.createUser({
        email: props.email,
        password: props.password,
        displayName: props.full_name,
        phoneNumber: props.phone_number,
      });

      return userRecord;
    } catch (error) {
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

  private async cleanupFirebaseUser(email: string) {
    try {
      const userRecord = await this.firebaseAuth.getUserByEmail(email);
      await this.firebaseAuth.deleteUser(userRecord.uid);
    } catch (error) {
      // Best-effort: es un rollback de compensación (el usuario en DB ya se
      // revirtió); si Firebase falla acá solo puede quedar un usuario
      // huérfano en Firebase, no rompemos el flujo, pero dejamos rastro.
      this.logger.warn(
        `No se pudo limpiar el usuario Firebase de ${email}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }


  /**
   * Lista clientes. Los clientes son GLOBALES (uno puede pedir a varias
   * distribuidoras), así que el scoping por tenant no es una columna sino una
   * relación: si viene `distributorId` (admin de empresa, o super_admin con
   * "ver como"), devuelve solo los clientes que tienen al menos un pedido con
   * esa distribuidora. Sin él (super_admin cross-tenant) devuelve todos.
   */
  async findAll(paginationDto: PaginationDto, distributorId?: string | null) {
    const { limit = 10, offset = 0 } = paginationDto;

    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('user.addresses', 'addresses')
      .take(limit)
      .skip(offset);

    if (distributorId) {
      qb.andWhere((sub) => {
        const query = sub
          .subQuery()
          .select('1')
          .from(Order, 'o')
          .where('o.customer_id = customer.user_id')
          .andWhere('o.distributor_id = :distributorId')
          .getQuery();
        return `EXISTS ${query}`;
      }).setParameter('distributorId', distributorId);
    }

    return qb.getMany();
  }

  async findOne(id: string) {
    const customer = await this.customerRepository.findOne({
      where: { customer_id: id },
      relations: ['user', 'user.role', 'user.addresses'],
    });

    if (!customer) {
      throw new NotFoundException(`Customer with ID: ${id} not found`);
    }

    return customer;
  }

  async findOneByUserId(userId: string) {
    const customer = await this.customerRepository.findOne({
      where: { user_id: userId },
      relations: ['user', 'user.role', 'user.addresses'],
    });

    if (!customer) {
      throw new NotFoundException(`Customer for user ID: ${userId} not found`);
    }

    return customer;
  }

  // ✅ MÉTODO REQUERIDO: Buscar customer por email del usuario
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

  async update(id: string, updateCustomerDto: UpdateCustomerDto) {
    const customer = await this.customerRepository.preload({
      customer_id: id,
      ...updateCustomerDto,
    });

    if (!customer) {
      throw new NotFoundException(`Customer with ID: ${id} not found`);
    }

    await this.customerRepository.save(customer);
    return await this.findOne(id);
  }

  async remove(id: string) {
    const customer = await this.findOne(id);
    await this.customerRepository.softDelete({ customer_id: id });
    return { message: 'Customer deleted successfully' };
  }

  async validateCustomer(id: string) {
    const customer = await this.findOne(id);
    customer.validated = 'true';
    await this.customerRepository.save(customer);
    return customer;
  }

  async invalidateCustomer(id: string) {
    const customer = await this.findOne(id);
    customer.validated = 'false';
    await this.customerRepository.save(customer);
    return customer;
  }

  async updateLocation(id: string, latLng: string) {
    const customer = await this.findOne(id);
    customer.lat_lang = latLng;
    await this.customerRepository.save(customer);
    return customer;
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
    this.logger.error(error);
    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
  }
}
