import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { GasCylinder } from './entities/gascylinder.entity';
import { CreateGasCylinderDto } from './dto/create-gascylinder.dto';
import { UpdateGasCylinderDto } from './dto/update-gascylinder.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';

@Injectable()
export class GasCylinderService {
  constructor(
    @InjectRepository(GasCylinder)
    private readonly gasCylinderRepository: Repository<GasCylinder>,
  ) {}

  async create(createGasCylinderDto: CreateGasCylinderDto) {
    const existing = await this.gasCylinderRepository.findOne({
      where: { type: createGasCylinderDto.type },
    });

    if (existing) {
      throw new BadRequestException('Ya existe una garrafa con este tipo');
    }

    const gasCylinder = this.gasCylinderRepository.create(createGasCylinderDto);
    try {
      return await this.gasCylinderRepository.save(gasCylinder);
    } catch (error) {
      this.handleDBExceptions(error);
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;

    const [gasCylinders, total] = await this.gasCylinderRepository.findAndCount(
      {
        where: { isActive: true },
        take: limit,
        skip: offset,
        order: { type: 'ASC' },
      },
    );

    return {
      gasCylinders,
      total,
      limit,
      offset,
    };
  }

  async findOne(id: string) {
    const gasCylinder = await this.gasCylinderRepository.findOne({
      where: { gas_cylinder_id: id },
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }

    return gasCylinder;
  }

  async findByType(type: string) {
    const gasCylinder = await this.gasCylinderRepository.findOne({
      where: { type, isActive: true },
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder type ${type} not found`);
    }

    return gasCylinder;
  }

  async update(id: string, updateGasCylinderDto: UpdateGasCylinderDto) {
    const gasCylinder = await this.gasCylinderRepository.preload({
      gas_cylinder_id: id,
      ...updateGasCylinderDto,
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }

    return await this.gasCylinderRepository.save(gasCylinder);
  }

  async updateStock(id: string, quantity: number) {
    const gasCylinder = await this.findOne(id);
    gasCylinder.stock += quantity; // <--- AQUÍ ESTÁ EL TEMA

    if (gasCylinder.stock < 0) {
      throw new BadRequestException('Stock cannot be negative');
    }

    return await this.gasCylinderRepository.save(gasCylinder);
  }

  async remove(id: string) {
    const gasCylinder = await this.findOne(id);
    gasCylinder.isActive = false;

    await this.gasCylinderRepository.save(gasCylinder);

    return {
      message: 'Gas cylinder deactivated successfully',
      gasCylinderId: id,
    };
  }

  async getAvailableCylinders() {
    const products = await this.gasCylinderRepository.find({
      where: {
        isActive: true,
        stock: MoreThan(0),
      },
      order: { type: 'ASC' },
    });

    return {
      products,
      paymentMethods: [
        {
          name: 'Efectivo',
          key: 'CASH',
          surcharge: 0,
        },
        {
          name: 'MercadoPago / Transferencia',
          key: 'TRANSFER',
          surcharge: 10, // 10%
        },
      ],
    };
  }

  private handleDBExceptions(error: any) {
    if (error.code === '23505') {
      throw new BadRequestException('Duplicate entry', error.detail);
    }

    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
  }
}
