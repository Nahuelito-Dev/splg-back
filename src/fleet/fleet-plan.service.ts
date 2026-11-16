import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import {
  MaintenancePlan,
  MaintenanceTrigger,
} from './entities/maintenance-plan.entity';
import { CreateFleetPlanDto } from './dto/create-plan.dto';
import { UpdateFleetPlanDto } from './dto/update-plan.dto';
import { QueryFleetPlanDto } from './dto/query-plan.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';

/**
 * Planes de mantenimiento/habilitación de la flota (CU-136 a CU-142): la
 * REGLA (qué se controla, cada cuánto, con qué anticipación, si inhabilita).
 * CRUD acotado por distribuidora; las tareas concretas las maneja
 * `FleetTaskService`.
 */
@Injectable()
export class FleetPlanService {
  private readonly logger = new Logger(FleetPlanService.name);

  constructor(
    @InjectRepository(MaintenancePlan)
    private readonly plans: Repository<MaintenancePlan>,
  ) {}

  async create(
    dto: CreateFleetPlanDto,
    distributorId: string,
  ): Promise<MaintenancePlan> {
    this.assertIntervaloCoherente(dto);

    const plan = this.plans.create({
      name: dto.name,
      subject: dto.subject,
      trigger: dto.trigger,
      intervalKm: dto.intervalKm ?? null,
      intervalMonths: dto.intervalMonths ?? null,
      leadTimeDays: dto.leadTimeDays,
      criticality: dto.criticality,
      carType: dto.carType ?? null,
      documentKind: dto.documentKind ?? null,
      appliesToCategories: dto.appliesToCategories ?? null,
      isActive: dto.isActive ?? true,
      distributorId,
    });

    try {
      return await this.plans.save(plan);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'planes de flota');
    }
  }

  async findAll(
    distributorId: string,
    query: QueryFleetPlanDto,
  ): Promise<MaintenancePlan[]> {
    const where: FindOptionsWhere<MaintenancePlan> = { distributorId };
    if (query.subject) where.subject = query.subject;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    return this.plans.find({ where, order: { name: 'ASC' } });
  }

  async findOne(id: string, distributorId: string): Promise<MaintenancePlan> {
    const plan = await this.plans.findOne({
      where: { planId: id, distributorId },
    });
    if (!plan) {
      throw new NotFoundException('Plan no encontrado');
    }
    return plan;
  }

  async update(
    id: string,
    dto: UpdateFleetPlanDto,
    distributorId: string,
  ): Promise<MaintenancePlan> {
    const actual = await this.findOne(id, distributorId);

    this.assertIntervaloCoherente({
      trigger: dto.trigger ?? actual.trigger,
      intervalKm: dto.intervalKm ?? actual.intervalKm ?? undefined,
      intervalMonths: dto.intervalMonths ?? actual.intervalMonths ?? undefined,
    });

    Object.assign(
      actual,
      sinIndefinidos({
        name: dto.name,
        subject: dto.subject,
        trigger: dto.trigger,
        intervalKm: dto.intervalKm,
        intervalMonths: dto.intervalMonths,
        leadTimeDays: dto.leadTimeDays,
        criticality: dto.criticality,
        carType: dto.carType,
        documentKind: dto.documentKind,
        appliesToCategories: dto.appliesToCategories,
        isActive: dto.isActive,
      }),
    );

    try {
      return await this.plans.save(actual);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'planes de flota');
    }
  }

  private assertIntervaloCoherente(dto: {
    trigger: MaintenanceTrigger;
    intervalKm?: number;
    intervalMonths?: number;
  }): void {
    if (dto.trigger === MaintenanceTrigger.BY_KM && !dto.intervalKm) {
      throw new BadRequestException(
        'Un plan por km necesita el intervalo en km (p. ej. cada 10000 km)',
      );
    }
    if (dto.trigger === MaintenanceTrigger.BY_TIME && !dto.intervalMonths) {
      throw new BadRequestException(
        'Un plan por tiempo necesita el intervalo en meses (p. ej. cada 6 meses)',
      );
    }
    if (
      dto.trigger === MaintenanceTrigger.BY_FIXED_DATE &&
      (dto.intervalKm || dto.intervalMonths)
    ) {
      throw new BadRequestException(
        'Un plan por fecha fija no lleva intervalo en km ni en meses: la fecha la fija cada tarea',
      );
    }
  }
}
