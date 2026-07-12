import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Distributor,
  DistributorStatus,
} from './entities/distributor.entity';
import { CreateDistributorDto } from './dto/create-distributor.dto';
import { UpdateDistributorDto } from './dto/update-distributor.dto';

@Injectable()
export class DistributorService {
  constructor(
    @InjectRepository(Distributor)
    private readonly repo: Repository<Distributor>,
  ) {}

  async create(dto: CreateDistributorDto): Promise<Distributor> {
    const existing = await this.repo.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException(
        `Ya existe una distribuidora con slug '${dto.slug}'`,
      );
    }
    const distributor = this.repo.create(dto);
    return this.repo.save(distributor);
  }

  findAll(): Promise<Distributor[]> {
    return this.repo.find({ order: { createdAt: 'ASC' } });
  }

  async findOne(id: string): Promise<Distributor> {
    const distributor = await this.repo.findOne({
      where: { distributor_id: id },
    });
    if (!distributor) {
      throw new NotFoundException(`Distribuidora ${id} no encontrada`);
    }
    return distributor;
  }

  async findBySlug(slug: string): Promise<Distributor> {
    const distributor = await this.repo.findOne({ where: { slug } });
    if (!distributor) {
      throw new NotFoundException(`Distribuidora '${slug}' no encontrada`);
    }
    return distributor;
  }

  /**
   * Distribuidora por defecto (compatibilidad hacia atrás). Los flujos de
   * cliente que aún NO mandan `X-Distributor` (apps previas al multi-tenant)
   * caen acá para seguir funcionando como single-tenant. Resolución:
   *   1. la de slug `DEFAULT_DISTRIBUTOR_SLUG` (env; default 'jeny-gas'),
   *   2. si no existe, la distribuidora activa más antigua,
   *   3. null si no hay ninguna.
   */
  async getDefault(): Promise<Distributor | null> {
    const slug = process.env.DEFAULT_DISTRIBUTOR_SLUG || 'jeny-gas';
    const bySlug = await this.repo.findOne({ where: { slug } });
    if (bySlug) return bySlug;
    return this.repo.findOne({
      where: { status: DistributorStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Devuelve la distribuidora sólo si está activa (para flujos de cliente:
   * no se puede pedir a una distribuidora suspendida). Lanza si no existe o
   * está suspendida.
   */
  async assertActive(id: string): Promise<Distributor> {
    const distributor = await this.findOne(id);
    if (distributor.status !== DistributorStatus.ACTIVE) {
      throw new NotFoundException(
        `La distribuidora '${distributor.name}' no está disponible`,
      );
    }
    return distributor;
  }

  async update(id: string, dto: UpdateDistributorDto): Promise<Distributor> {
    const distributor = await this.findOne(id);
    Object.assign(distributor, dto);
    return this.repo.save(distributor);
  }

  async remove(id: string): Promise<void> {
    const distributor = await this.findOne(id);
    await this.repo.softRemove(distributor);
  }
}
