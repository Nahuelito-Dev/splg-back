import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { UserAddress } from './entities/user-addres.entity';
import { CreateUserAddresDto } from './dto/create-user-addres.dto';
import { UpdateUserAddresDto } from './dto/update-user-addres.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class UserAddresService {
  constructor(
    @InjectRepository(UserAddress)
    private readonly userAddressRepository: Repository<UserAddress>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(createUserAddressDto: CreateUserAddresDto) {
    const user = await this.userRepository.findOne({
      where: { user_id: createUserAddressDto.user_id },
    });

    if (!user) {
      throw new NotFoundException(
        `User with ID: ${createUserAddressDto.user_id} not found`,
      );
    }

    if (createUserAddressDto.isDefault) {
      await this.removeDefaultFromOtherAddresses(createUserAddressDto.user_id);
    }

    const address = this.userAddressRepository.create(createUserAddressDto);
    return await this.userAddressRepository.save(address);
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;

    const [addresses, total] = await this.userAddressRepository.findAndCount({
      take: limit,
      skip: offset,
      relations: ['user'],
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });

    return {
      addresses,
      total,
      limit,
      offset,
    };
  }

  async findOne(id: string) {
    const address = await this.userAddressRepository.findOne({
      where: { address_id: id },
      relations: ['user'],
    });

    if (!address) {
      throw new NotFoundException(`Address with ID: ${id} not found`);
    }

    return address;
  }

  async findByUserId(userId: string) {
    const addresses = await this.userAddressRepository.find({
      where: { user_id: userId },
      relations: ['user'],
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });

    return addresses;
  }

  async findDefaultByUserId(userId: string) {
    const address = await this.userAddressRepository.findOne({
      where: { user_id: userId, isDefault: true },
      relations: ['user'],
    });

    if (!address) {
      const addresses = await this.findByUserId(userId);
      if (addresses.length > 0) {
        return addresses[0];
      }
      throw new NotFoundException(`No addresses found for user: ${userId}`);
    }

    return address;
  }

  async update(id: string, updateUserAddressDto: UpdateUserAddresDto) {
    const address = await this.userAddressRepository.preload({
      address_id: id,
      ...updateUserAddressDto,
    });

    if (!address) {
      throw new NotFoundException(`Address with ID: ${id} not found`);
    }

    if (updateUserAddressDto.isDefault) {
      await this.removeDefaultFromOtherAddresses(address.user_id, id);
    }

    return await this.userAddressRepository.save(address);
  }

  async remove(id: string) {
    const address = await this.findOne(id);

    if (address.isDefault) {
      const otherAddresses = await this.userAddressRepository.find({
        where: {
          user_id: address.user_id,
          address_id: Not(id),
        },
        order: { createdAt: 'DESC' },
      });

      if (otherAddresses.length > 0) {
        otherAddresses[0].isDefault = true;
        await this.userAddressRepository.save(otherAddresses[0]);
      }
    }

    await this.userAddressRepository.remove(address);

    return {
      message: 'Address deleted successfully',
      addressId: id,
    };
  }

  async setAsDefault(id: string) {
    const address = await this.findOne(id);
    await this.removeDefaultFromOtherAddresses(address.user_id, id);

    address.isDefault = true;
    return await this.userAddressRepository.save(address);
  }

  private async removeDefaultFromOtherAddresses(
    userId: string,
    excludeAddressId?: string,
  ) {
    const whereClause: any = { user_id: userId, isDefault: true };

    if (excludeAddressId) {
      // TypeORM (Postgres), NO Mongo: usar Not(), no `{ $not: ... }` (rompía
      // con 500 al marcar una dirección como predeterminada).
      whereClause.address_id = Not(excludeAddressId);
    }

    const defaultAddresses = await this.userAddressRepository.find({
      where: whereClause,
    });

    for (const address of defaultAddresses) {
      address.isDefault = false;
      await this.userAddressRepository.save(address);
    }
  }

  private handleDBExceptions(error: any) {
    if (error.code === '23505') {
      throw new BadRequestException('Duplicate entry', error.detail);
    }

    if (error.code === '23503') {
      throw new BadRequestException('Foreign key constraint failed');
    }

    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
  }
}
