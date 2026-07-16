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
import { Order } from '../order/entities/order.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger('CustomersService');

  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) { }


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
