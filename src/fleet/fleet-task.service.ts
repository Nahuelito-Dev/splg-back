import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  MaintenancePlan,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';
import { CreateFleetTaskDto } from './dto/create-task.dto';
import { UpdateFleetTaskDto } from './dto/update-task.dto';
import { CloseFleetTaskDto } from './dto/close-task.dto';
import { CancelFleetTaskDto } from './dto/cancel-task.dto';
import { QueryFleetTaskDto } from './dto/query-task.dto';
import { CarService } from '../car/car.service';
import { DeliveryService } from '../delivery/delivery.service';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { estaInhabilitado } from './domain/fleet-lock.util';
import { calcularEstadoDeVencimiento } from './domain/expiration-status';

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * Tareas de flota: cada vencimiento/servicio concreto de un plan (CU-136 a
 * CU-141). Una tarea apunta a un vehículo o a un chofer, según el `subject`
 * de su plan; nunca a los dos ni a ninguno.
 */
@Injectable()
export class FleetTaskService {
  private readonly logger = new Logger(FleetTaskService.name);

  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    @InjectRepository(MaintenancePlan)
    private readonly plans: Repository<MaintenancePlan>,
    private readonly carService: CarService,
    private readonly deliveryService: DeliveryService,
  ) {}

  async create(
    dto: CreateFleetTaskDto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const plan = await this.findPlanOrThrow(dto.planId, distributorId);
    await this.assertSujetoCoherente(plan, dto, distributorId);

    const task = this.tasks.create({
      planId: plan.planId,
      distributorId,
      carId: dto.carId ?? null,
      deliveryId: dto.deliveryId ?? null,
      status: MaintenanceTaskStatus.SCHEDULED,
      dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
      dueKm: dto.dueKm ?? null,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      performedAt: null,
      odometerKm: null,
      cost: null,
      provider: dto.provider ?? null,
      referenceNumber: dto.referenceNumber ?? null,
      category: dto.category ?? null,
      alertedAt: null,
      notes: dto.notes ?? null,
    });

    try {
      const saved = await this.tasks.save(task);
      saved.plan = plan;
      return saved;
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }
  }

  async findAll(
    distributorId: string,
    query: QueryFleetTaskDto,
  ): Promise<MaintenanceTask[]> {
    const qb = this.tasks
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.plan', 'plan')
      .where('task.distributor_id = :distributorId', { distributorId });

    if (query.carId)
      qb.andWhere('task.car_id = :carId', { carId: query.carId });
    if (query.deliveryId) {
      qb.andWhere('task.delivery_id = :deliveryId', {
        deliveryId: query.deliveryId,
      });
    }
    if (query.status)
      qb.andWhere('task.status = :status', { status: query.status });

    // `take`/`skip` (paginación "relacional") + `leftJoinAndSelect` +
    // `orderBy` sobre una columna de la entidad raíz rompen esta versión de
    // TypeORM (TypeError leyendo `databaseName` al reconstruir el ORDER BY
    // dentro de la subquery de paginación). `limit`/`offset` (SQL directo) no
    // tienen ese problema, y acá alcanza: el único join es a `plan`
    // (ManyToOne), que no duplica filas.
    // Postgres ya pone los NULL al final en ASC por default: no hace falta
    // pedir 'NULLS LAST' aparte.
    qb.orderBy('task.due_at', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0);

    return qb.getMany();
  }

  async findOne(id: string, distributorId: string): Promise<MaintenanceTask> {
    const task = await this.tasks.findOne({
      where: { taskId: id, distributorId },
      relations: ['plan'],
    });
    if (!task) {
      throw new NotFoundException(`Tarea ${id} no encontrada`);
    }
    return task;
  }

  async update(
    id: string,
    dto: UpdateFleetTaskDto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const task = await this.findOne(id, distributorId);
    this.assertAbierta(task);

    Object.assign(
      task,
      sinIndefinidos({
        dueAt: dto.dueAt ? new Date(dto.dueAt) : dto.dueAt,
        dueKm: dto.dueKm,
        provider: dto.provider,
        referenceNumber: dto.referenceNumber,
        category: dto.category,
        notes: dto.notes,
        scheduledAt: dto.scheduledAt
          ? new Date(dto.scheduledAt)
          : dto.scheduledAt,
      }),
    );

    try {
      return await this.tasks.save(task);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }
  }

  /** CU-141: registrar que el mantenimiento/habilitación se hizo. */
  async close(
    id: string,
    dto: CloseFleetTaskDto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const task = await this.findOne(id, distributorId);
    this.assertAbierta(task);

    task.performedAt = new Date(dto.performedAt);
    task.odometerKm = dto.odometerKm ?? task.odometerKm;
    task.cost = dto.cost ?? task.cost;
    task.provider = dto.provider ?? task.provider;
    task.notes = dto.notes ?? task.notes;
    task.status = MaintenanceTaskStatus.DONE;

    return this.tasks.save(task);
  }

  async cancel(
    id: string,
    dto: CancelFleetTaskDto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const task = await this.findOne(id, distributorId);
    this.assertAbierta(task);

    task.status = MaintenanceTaskStatus.CANCELLED;
    if (dto.notes) {
      task.notes = task.notes
        ? `${task.notes}\n\nCancelada: ${dto.notes}`
        : `Cancelada: ${dto.notes}`;
    }

    return this.tasks.save(task);
  }

  /** CU-136/137: documentación de un vehículo, y si está inhabilitado. */
  async listByCar(
    carId: string,
    distributorId: string,
  ): Promise<{ tasks: MaintenanceTask[]; isLocked: boolean }> {
    await this.carService.findOne(carId, distributorId); // 404 si no existe/no es de esta distribuidora

    const tasks = await this.tasks.find({
      where: { carId, distributorId },
      relations: ['plan'],
      order: { dueAt: 'ASC' },
    });

    return { tasks, isLocked: this.calcularBloqueo(tasks) };
  }

  /** CU-138: documentación de un chofer, y si está inhabilitado. */
  async listByDelivery(
    deliveryId: string,
    distributorId: string,
  ): Promise<{ tasks: MaintenanceTask[]; isLocked: boolean }> {
    const delivery = await this.deliveryService.findOne(deliveryId); // 404 si no existe
    if (delivery.distributorId !== distributorId) {
      throw new NotFoundException(`Chofer ${deliveryId} no encontrado`);
    }

    const tasks = await this.tasks.find({
      where: { deliveryId, distributorId },
      relations: ['plan'],
      order: { dueAt: 'ASC' },
    });

    return { tasks, isLocked: this.calcularBloqueo(tasks) };
  }

  /**
   * CU-136/137/138: un vehículo/chofer está inhabilitado si tiene una tarea
   * ABIERTA de un plan bloqueante, vencida. Sólo cuenta el estado de la
   * habilitación (no aplica todavía al despacho — ver el informe de esta
   * tarea para el punto de enganche).
   */
  private calcularBloqueo(tasks: MaintenanceTask[]): boolean {
    const abiertas = tasks.filter((t) => !ESTADOS_CERRADOS.includes(t.status));
    return estaInhabilitado(
      abiertas.map((t) => ({
        criticality: t.plan.criticality,
        expirationStatus: calcularEstadoDeVencimiento(
          t.dueAt,
          t.plan.leadTimeDays,
        ),
      })),
    );
  }

  private assertAbierta(task: MaintenanceTask): void {
    if (ESTADOS_CERRADOS.includes(task.status)) {
      throw new BadRequestException(
        `La tarea ya está ${task.status === MaintenanceTaskStatus.DONE ? 'hecha' : 'cancelada'}`,
      );
    }
  }

  private async findPlanOrThrow(
    planId: string,
    distributorId: string,
  ): Promise<MaintenancePlan> {
    const plan = await this.plans.findOne({
      where: { planId, distributorId },
    });
    if (!plan) {
      throw new NotFoundException(`Plan ${planId} no encontrado`);
    }
    return plan;
  }

  /** El vehículo/chofer que llega tiene que coincidir con `plan.subject` y ser de la misma distribuidora. */
  private async assertSujetoCoherente(
    plan: MaintenancePlan,
    dto: CreateFleetTaskDto,
    distributorId: string,
  ): Promise<void> {
    if (plan.subject === MaintenanceSubject.VEHICLE) {
      if (!dto.carId || dto.deliveryId) {
        throw new BadRequestException(
          'Un plan de vehículo necesita carId (y no deliveryId)',
        );
      }
      await this.carService.findOne(dto.carId, distributorId); // 404 si no existe/no es de esta distribuidora
      return;
    }

    if (!dto.deliveryId || dto.carId) {
      throw new BadRequestException(
        'Un plan de chofer necesita deliveryId (y no carId)',
      );
    }
    const delivery = await this.deliveryService.findOne(dto.deliveryId);
    if (delivery.distributorId !== distributorId) {
      throw new NotFoundException(`Chofer ${dto.deliveryId} no encontrado`);
    }
  }
}
