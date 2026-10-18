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
  MaintenanceDocumentKind,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from './entities/maintenance-plan.entity';
import { JobPositionCategory } from '../employee/entities/job-position.entity';
import { CreateFleetTaskDto } from './dto/create-task.dto';
import { UpdateFleetTaskDto } from './dto/update-task.dto';
import { CloseFleetTaskDto } from './dto/close-task.dto';
import { CancelFleetTaskDto } from './dto/cancel-task.dto';
import { QueryFleetTaskDto } from './dto/query-task.dto';
import { CarService } from '../car/car.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeConPuesto } from '../employee/employee.mapper';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import {
  describirVencimiento,
  estaInhabilitado,
  normalizarFechaCalendario,
  tareasQueInhabilitan,
} from './domain/fleet-lock.util';
import { calcularEstadoDeVencimiento } from './domain/expiration-status';
import { validarDetalle } from './domain/document-details';

/** Fecha de calendario del cuerpo: `undefined` no se toca, `null` borra, un ISO se normaliza. */
function fechaDeCalendario(valor: string | null | undefined) {
  if (valor === null) return null;
  return valor ? normalizarFechaCalendario(new Date(valor)) : undefined;
}

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * Tareas de flota: cada vencimiento/servicio concreto de un plan (CU-136 a
 * CU-141) y la documentación del personal (CU-183 a CU-185). Una tarea apunta a
 * un vehículo, a un chofer o a un empleado, según el `subject` de su plan;
 * nunca a dos ni a ninguno.
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
    private readonly employees: EmployeeService,
    // Gate único de bloqueo de flota (CU-136 a CU-138): lo usa `listByDelivery`
    // para que la ficha del chofer muestre el MISMO `isLocked` que aplica el
    // despacho (incluye el vehículo que maneja, no sólo su propia licencia).
    private readonly fleetLock: FleetDispatchLockService,
  ) {}

  async create(
    dto: CreateFleetTaskDto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const plan = await this.findPlanOrThrow(dto.planId, distributorId);
    const empleado = await this.assertSujetoCoherente(plan, dto, distributorId);
    this.assertDatosDelDocumento(plan, dto, empleado);

    const dueAt = dto.dueAt
      ? normalizarFechaCalendario(new Date(dto.dueAt))
      : null;
    const validFrom = dto.validFrom
      ? normalizarFechaCalendario(new Date(dto.validFrom))
      : null;
    this.assertVigenciaCoherente(plan, validFrom, dueAt);

    const task = this.tasks.create({
      planId: plan.planId,
      distributorId,
      carId: dto.carId ?? null,
      deliveryId: dto.deliveryId ?? null,
      employeeId: empleado?.employeeId ?? null,
      status: MaintenanceTaskStatus.SCHEDULED,
      // Fecha de calendario: si el ISO trae hora (datepicker con hora local,
      // etc.), se normaliza a medianoche UTC para no correr el vencimiento a
      // otro día (revisión de vehículo en uso).
      dueAt,
      validFrom,
      dueKm: dto.dueKm ?? null,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      performedAt: null,
      odometerKm: null,
      cost: dto.cost ?? null,
      provider: dto.provider ?? null,
      referenceNumber: dto.referenceNumber ?? null,
      category: dto.category ?? null,
      alertedAt: null,
      notes: dto.notes ?? null,
      details: this.detalleValidado(plan, dto),
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
  ): Promise<[MaintenanceTask[], number]> {
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
    if (query.employeeId) {
      qb.andWhere('task.employee_id = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.planId)
      qb.andWhere('task.plan_id = :planId', { planId: query.planId });
    if (query.status)
      qb.andWhere('task.status = :status', { status: query.status });

    // El total es el de los filtros, sin paginar.
    const total = await qb.getCount();

    // `take`/`skip` (paginación "relacional") + `leftJoinAndSelect` +
    // `orderBy` sobre una columna de la entidad raíz rompen esta versión de
    // TypeORM (TypeError leyendo `databaseName` al reconstruir el ORDER BY
    // dentro de la subquery de paginación). `limit`/`offset` (SQL directo) no
    // tienen ese problema, y acá alcanza: el único join es a `plan`
    // (ManyToOne), que no duplica filas.
    // `NULLS LAST` explícito, y el id como desempate: dos tareas con la misma
    // fecha de vencimiento (o sin ella) tienen siempre el mismo orden, así la
    // paginación no repite ni se salta filas.
    qb.orderBy('task.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('task.task_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0);

    return [await qb.getMany(), total];
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

    const dueAt = fechaDeCalendario(dto.dueAt);
    const validFrom = fechaDeCalendario(dto.validFrom);
    this.assertVigenciaCoherente(
      task.plan,
      validFrom === undefined ? task.validFrom : validFrom,
      dueAt === undefined ? task.dueAt : dueAt,
    );

    Object.assign(
      task,
      sinIndefinidos({
        dueAt,
        validFrom,
        cost: dto.cost,
        dueKm: dto.dueKm,
        provider: dto.provider,
        referenceNumber: dto.referenceNumber,
        category: dto.category,
        notes: dto.notes,
        scheduledAt: dto.scheduledAt
          ? new Date(dto.scheduledAt)
          : dto.scheduledAt,
        details:
          dto.details === undefined
            ? undefined
            : this.detalleValidado(task.plan, dto),
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

    // El kilometraje del vehículo se sube con el del cierre, por el mismo
    // punto que usan las cargas de combustible: ninguno pisa al otro.
    return this.tasks.manager.transaction(async (manager) => {
      const guardada = await manager.getRepository(MaintenanceTask).save(task);
      if (guardada.carId && dto.odometerKm !== undefined) {
        await this.carService.actualizarOdometro(
          manager,
          guardada.carId,
          dto.odometerKm,
        );
      }
      return guardada;
    });
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

  /**
   * Qué está vencido en el vehículo, en castellano y con fecha. Vacío si el
   * vehículo está en condiciones. Lo usa `DeliveryVehicleController` (en
   * `fleet`) ANTES de poner un vehículo en uso (CU-136/137): un vehículo
   * inhabilitado no puede asignarse a ningún chofer. `CarService` no puede
   * hacer este chequeo (viviría en `car`, que no puede depender de `fleet`
   * sin generar un ciclo — CONVENCIONES §4), así que lo resuelve el
   * controlador llamando a este método antes de `VehicleAssignmentService.ponerEnUso`.
   */
  async motivosDeInhabilitacionDeVehiculo(
    carId: string,
    distributorId: string,
  ): Promise<string[]> {
    await this.carService.findOne(carId, distributorId); // 404 si no existe/no es de esta distribuidora

    const tasks = await this.tasks.find({
      where: { carId, distributorId },
      relations: ['plan'],
    });
    const abiertas = tasks.filter((t) => !ESTADOS_CERRADOS.includes(t.status));
    const conEstado = abiertas.map((t) => ({
      task: t,
      criticality: t.plan.criticality,
      expirationStatus: calcularEstadoDeVencimiento(
        t.dueAt,
        t.plan.leadTimeDays,
      ),
    }));

    return tareasQueInhabilitan(conEstado).map((c) =>
      describirVencimiento(c.task.plan.name, c.task.dueAt),
    );
  }

  /** 400 si el vehículo está inhabilitado por documentación vencida (CU-136/137). */
  async assertVehiculoHabilitado(
    carId: string,
    distributorId: string,
  ): Promise<void> {
    const motivos = await this.motivosDeInhabilitacionDeVehiculo(
      carId,
      distributorId,
    );
    if (motivos.length > 0) {
      throw new BadRequestException(
        `No se puede asignar: ${motivos.join('; ')}.`,
      );
    }
  }

  /**
   * CU-138: documentación de un chofer, y si está inhabilitado. `isLocked`
   * sale del MISMO gate que usa el despacho (`FleetDispatchLockService`):
   * no sólo la licencia propia, también el vehículo que maneja. `tasks` es
   * sólo lo propio del chofer (su licencia): lo del vehículo se consulta en
   * `/cars/:id/documents`.
   */
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

    const inhabilitados = await this.fleetLock.choferesInhabilitados(
      [delivery.userId],
      distributorId,
    );

    return { tasks, isLocked: inhabilitados.has(delivery.userId) };
  }

  /**
   * CU-136/137: un vehículo está inhabilitado si tiene una tarea ABIERTA de
   * un plan bloqueante, vencida. A diferencia de `listByDelivery`, acá no
   * hace falta el gate compartido: un vehículo no se inhabilita por nada
   * ajeno a sus propias tareas.
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

  /**
   * La vigencia de un documento: el inicio no puede ser posterior al
   * vencimiento, y la habilitación de mercancías peligrosas (CU-197) no se
   * registra sin vencimiento: es lo que la hace bloqueante.
   */
  private assertVigenciaCoherente(
    plan: MaintenancePlan,
    validFrom: Date | null | undefined,
    dueAt: Date | null | undefined,
  ): void {
    if (
      plan.documentKind === MaintenanceDocumentKind.HAZMAT_VEHICLE_PERMIT &&
      !dueAt
    ) {
      throw new BadRequestException(
        'dueAt: la habilitación necesita la fecha de vencimiento',
      );
    }
    if (validFrom && dueAt && validFrom.getTime() > dueAt.getTime()) {
      throw new BadRequestException(
        'validFrom: el inicio de la vigencia no puede ser posterior al vencimiento',
      );
    }
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

  /**
   * El vehículo/chofer/empleado que llega tiene que coincidir con
   * `plan.subject` y ser de la misma distribuidora. Para un plan de personal
   * devuelve el legajo (activo y al que el plan le aplica).
   */
  private async assertSujetoCoherente(
    plan: MaintenancePlan,
    dto: CreateFleetTaskDto,
    distributorId: string,
  ): Promise<EmployeeConPuesto | null> {
    if (plan.subject === MaintenanceSubject.VEHICLE) {
      if (!dto.carId || dto.deliveryId || dto.employeeId) {
        throw new BadRequestException(
          'Un plan de vehículo necesita carId (y no deliveryId ni employeeId)',
        );
      }
      await this.carService.findOne(dto.carId, distributorId); // 404 si no existe/no es de esta distribuidora
      return null;
    }

    if (plan.subject === MaintenanceSubject.EMPLOYEE) {
      if (!dto.employeeId || dto.carId || dto.deliveryId) {
        throw new BadRequestException(
          'Un plan de personal necesita employeeId (y no carId ni deliveryId)',
        );
      }
      // 404 si no existe/no es de esta distribuidora; 409 si está egresado
      const empleado = await this.employees.findActivo(
        dto.employeeId,
        distributorId,
      );
      if (!plan.isActive) {
        throw new BadRequestException(`El plan «${plan.name}» está inactivo`);
      }
      if (!aplicaALaCategoria(plan, empleado.position.category)) {
        throw new BadRequestException(
          `El plan «${plan.name}» no aplica a la categoría del puesto del empleado (${empleado.position.category})`,
        );
      }
      return empleado;
    }

    if (!dto.deliveryId || dto.carId || dto.employeeId) {
      throw new BadRequestException(
        'Un plan de chofer necesita deliveryId (y no carId ni employeeId)',
      );
    }
    const delivery = await this.deliveryService.findOne(dto.deliveryId);
    if (delivery.distributorId !== distributorId) {
      throw new NotFoundException(`Chofer ${dto.deliveryId} no encontrado`);
    }
    return null;
  }

  /** Un plan de personal por fecha fija necesita el vencimiento: es lo que se registra. */
  private assertDatosDelDocumento(
    plan: MaintenancePlan,
    dto: CreateFleetTaskDto,
    empleado: EmployeeConPuesto | null,
  ): void {
    if (empleado && plan.trigger === MaintenanceTrigger.BY_FIXED_DATE) {
      if (!dto.dueAt) {
        throw new BadRequestException(
          'dueAt: el vencimiento del documento es obligatorio',
        );
      }
    }
  }

  /** El detalle según el tipo de documento del plan, o 400 nombrando el campo. */
  private detalleValidado(
    plan: MaintenancePlan,
    dto: Pick<CreateFleetTaskDto, 'details'>,
  ): Record<string, string> | null {
    const resultado = validarDetalle(plan.documentKind, dto.details);
    if (!resultado.ok) {
      throw new BadRequestException(resultado.motivo);
    }
    return resultado.detalle;
  }
}

/** `appliesToCategories` vacío o `null` = aplica a todas las categorías. */
export function aplicaALaCategoria(
  plan: Pick<MaintenancePlan, 'appliesToCategories' | 'subject'>,
  categoria: JobPositionCategory,
): boolean {
  const categorias = plan.appliesToCategories;
  if (categorias === null || categorias.length === 0) {
    // Un plan de chofer sin categorías es el histórico de la licencia: aplica a los choferes.
    return plan.subject !== MaintenanceSubject.DRIVER
      ? true
      : categoria === JobPositionCategory.DRIVER;
  }
  return categorias.includes(categoria);
}
