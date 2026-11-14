import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { Distributor, DistributorStatus } from './entities/distributor.entity';
import { CreateDistributorDto } from './dto/create-distributor.dto';
import { UpdateDistributorDto } from './dto/update-distributor.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from './events/distribuidora-creada.event';

/**
 * El cuerpo de la API lleva `legal_name` y `tax_id`; la entidad,
 * camelCase. Se mapea campo por campo: `Object.assign(entidad, dto)` no da
 * error de tipos y pierde esos datos en silencio.
 */
function columnasDeLaDistribuidora(
  dto: UpdateDistributorDto,
): Partial<Distributor> {
  return sinIndefinidos({
    name: dto.name,
    legalName: dto.legal_name,
    taxId: dto.tax_id,
    email: dto.email,
    phone: dto.phone,
    status: dto.status,
    plan: dto.plan,
  });
}

@Injectable()
export class DistributorService {
  constructor(
    @InjectRepository(Distributor)
    private readonly repo: Repository<Distributor>,
    private readonly config: ConfigService,
    private readonly eventos: EventEmitter2,
  ) {}

  async create(dto: CreateDistributorDto): Promise<Distributor> {
    const existing = await this.repo.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException(
        `Ya existe una distribuidora con slug '${dto.slug}'`,
      );
    }
    const distributor = this.repo.create({
      ...columnasDeLaDistribuidora(dto),
      slug: dto.slug,
    });
    const guardada = await this.repo.save(distributor);

    // Confirmada el alta, se avisa para que quien tenga datos base por
    // distribuidora los siembre (hoy: los planes de mantenimiento de fleet).
    this.eventos.emit(
      EVENTO_DISTRIBUIDORA_CREADA,
      new DistribuidoraCreadaEvent(guardada.distributorId),
    );

    return guardada;
  }

  findAll(): Promise<Distributor[]> {
    return this.repo.find({ order: { createdAt: 'ASC' } });
  }

  async findOne(id: string): Promise<Distributor> {
    const distributor = await this.repo.findOne({
      where: { distributorId: id },
    });
    if (!distributor) {
      throw new NotFoundException('Distribuidora no encontrada');
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
   *   1. la de slug `DEFAULT_DISTRIBUTOR_SLUG` (env; default 'demo'),
   *   2. si no existe, la distribuidora activa más antigua,
   *   3. null si no hay ninguna.
   */
  async getDefault(): Promise<Distributor | null> {
    const slug = this.config.get<string>('DEFAULT_DISTRIBUTOR_SLUG', 'demo');
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

  /** La política de soporte de la empresa (modo soporte, D1). */
  async politicaDeSoporte(
    id: string,
  ): Promise<{ emergencyAllowed: boolean; autoApprove: boolean }> {
    const d = await this.findOne(id);
    return {
      emergencyAllowed: d.supportEmergencyAllowed,
      autoApprove: d.supportAutoApprove,
    };
  }

  /** Cambia la política de soporte; lo que no viene queda como estaba. */
  async actualizarPoliticaDeSoporte(
    id: string,
    cambios: { emergencyAllowed?: boolean; autoApprove?: boolean },
  ): Promise<{ emergencyAllowed: boolean; autoApprove: boolean }> {
    const d = await this.findOne(id);
    if (cambios.emergencyAllowed !== undefined) {
      d.supportEmergencyAllowed = cambios.emergencyAllowed;
    }
    if (cambios.autoApprove !== undefined) {
      d.supportAutoApprove = cambios.autoApprove;
    }
    const guardada = await this.repo.save(d);
    return {
      emergencyAllowed: guardada.supportEmergencyAllowed,
      autoApprove: guardada.supportAutoApprove,
    };
  }

  async update(id: string, dto: UpdateDistributorDto): Promise<Distributor> {
    const distributor = await this.findOne(id);
    Object.assign(distributor, columnasDeLaDistribuidora(dto));
    return this.repo.save(distributor);
  }

  async remove(id: string): Promise<void> {
    const distributor = await this.findOne(id);
    await this.repo.softRemove(distributor);
  }
}
