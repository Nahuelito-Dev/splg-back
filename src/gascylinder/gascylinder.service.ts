import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, FindOptionsWhere } from 'typeorm';
import { GasCylinder } from './entities/gascylinder.entity';
import { CreateGasCylinderDto } from './dto/create-gascylinder.dto';
import { UpdateGasCylinderDto } from './dto/update-gascylinder.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { DistributorService } from '../distributor/distributor.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class GasCylinderService {
  constructor(
    @InjectRepository(GasCylinder)
    private readonly gasCylinderRepository: Repository<GasCylinder>,
    private readonly distributorService: DistributorService,
  ) {}

  /**
   * Resuelve un `distributor_id` a partir de un slug o uuid. Usado por los
   * endpoints públicos del catálogo, donde el tenant llega por query
   * `?distributor=` (el guard no corre en rutas @Public).
   *
   * Compatibilidad hacia atrás: si NO se pasa distribuidora, cae a la default
   * (Jeny Gas) en vez de mezclar catálogos de todos los tenants — así la app
   * cliente previa al multi-tenant sigue viendo un catálogo coherente.
   */
  async resolveDistributor(slugOrId?: string): Promise<string | null> {
    if (!slugOrId) {
      const def = await this.distributorService.getDefault();
      return def?.distributor_id ?? null;
    }
    const distributor = UUID_RE.test(slugOrId)
      ? await this.distributorService.assertActive(slugOrId)
      : await this.distributorService.findBySlug(slugOrId);
    return distributor.distributor_id;
  }

  async create(
    createGasCylinderDto: CreateGasCylinderDto,
    distributorId: string,
  ) {
    // Unicidad de `type` es POR distribuidora: dos tenants pueden tener ambos
    // una "Garrafa 10kg".
    const existing = await this.gasCylinderRepository.findOne({
      where: { type: createGasCylinderDto.type, distributor_id: distributorId },
    });

    if (existing) {
      throw new BadRequestException(
        'Ya existe una garrafa con este tipo en tu distribuidora',
      );
    }

    const gasCylinder = this.gasCylinderRepository.create({
      ...createGasCylinderDto,
      distributor_id: distributorId,
    });
    try {
      return await this.gasCylinderRepository.save(gasCylinder);
    } catch (error) {
      this.handleDBExceptions(error);
    }
  }

  async findAll(paginationDto: PaginationDto, distributor?: string) {
    const { limit = 10, offset = 0 } = paginationDto;
    const distributorId = await this.resolveDistributor(distributor);

    const where: FindOptionsWhere<GasCylinder> = { isActive: true };
    if (distributorId) where.distributor_id = distributorId;

    const [gasCylinders, total] = await this.gasCylinderRepository.findAndCount(
      {
        where,
        take: limit,
        skip: offset,
        order: { type: 'ASC' },
      },
    );

    return { gasCylinders, total, limit, offset };
  }

  /**
   * `distributorId` opcional: si viene, la garrafa debe pertenecer a ese tenant
   * (evita que un admin lea/edite productos de otra distribuidora). En rutas
   * públicas de lectura se pasa null y no se restringe por tenant.
   */
  async findOne(id: string, distributorId?: string | null) {
    const where: FindOptionsWhere<GasCylinder> = { gas_cylinder_id: id };
    if (distributorId) where.distributor_id = distributorId;

    const gasCylinder = await this.gasCylinderRepository.findOne({ where });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }

    return gasCylinder;
  }

  async findByType(type: string, distributor?: string) {
    const distributorId = await this.resolveDistributor(distributor);
    const where: FindOptionsWhere<GasCylinder> = { type, isActive: true };
    if (distributorId) where.distributor_id = distributorId;

    const gasCylinder = await this.gasCylinderRepository.findOne({ where });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder type ${type} not found`);
    }

    return gasCylinder;
  }

  async update(
    id: string,
    updateGasCylinderDto: UpdateGasCylinderDto,
    distributorId: string,
  ) {
    // Verifica pertenencia al tenant antes de editar.
    await this.findOne(id, distributorId);

    const gasCylinder = await this.gasCylinderRepository.preload({
      gas_cylinder_id: id,
      ...updateGasCylinderDto,
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }

    return await this.gasCylinderRepository.save(gasCylinder);
  }

  async updateStock(id: string, quantity: number, distributorId: string) {
    const gasCylinder = await this.findOne(id, distributorId);
    gasCylinder.stock += quantity;

    if (gasCylinder.stock < 0) {
      throw new BadRequestException('Stock cannot be negative');
    }

    return await this.gasCylinderRepository.save(gasCylinder);
  }

  async remove(id: string, distributorId: string) {
    const gasCylinder = await this.findOne(id, distributorId);
    gasCylinder.isActive = false;

    await this.gasCylinderRepository.save(gasCylinder);

    return {
      message: 'Gas cylinder deactivated successfully',
      gasCylinderId: id,
    };
  }

  async getAvailableCylinders(distributor?: string) {
    const distributorId = await this.resolveDistributor(distributor);
    const where: FindOptionsWhere<GasCylinder> = {
      isActive: true,
      stock: MoreThan(0),
    };
    if (distributorId) where.distributor_id = distributorId;

    const products = await this.gasCylinderRepository.find({
      where,
      order: { type: 'ASC' },
    });

    return {
      products,
      paymentMethods: [
        { name: 'Efectivo', key: 'CASH', surcharge: 0 },
        { name: 'MercadoPago / Transferencia', key: 'TRANSFER', surcharge: 10 },
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
