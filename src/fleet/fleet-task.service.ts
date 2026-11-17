import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import { CashReferenceType, CashSystemCode } from '../cash/domain/cash.enums';
import { instanteValido } from '../cash/domain/instante-del-pago';
import { diaArgentino } from '../common/utils/dias-argentina';
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
import {
  CreateFleetTaskDto,
  CreateFleetTaskV2Dto,
} from './dto/create-task.dto';
import { UpdateFleetTaskDto } from './dto/update-task.dto';
import { CloseFleetTaskDto } from './dto/close-task.dto';
import { PayFleetTaskDto, PagoAlCerrar } from './dto/pay-task.dto';
import { CancelFleetTaskDto } from './dto/cancel-task.dto';
import { QueryFleetTaskDto } from './dto/query-task.dto';
import { CarService } from '../car/car.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeConPuesto } from '../employee/employee.mapper';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import {
  describirVencimiento,
  estaInhabilitado,
  normalizarFechaCalendario,
  tareasQueInhabilitan,
} from './domain/fleet-lock.util';
import { calcularEstadoDeVencimiento } from './domain/expiration-status';
import { validarDetalle } from './domain/document-details';
import { PlanningCaseCloser } from './planner/planning-case-closer.service';
import type { MaintenanceWindowProposal } from './entities/maintenance-window-proposal.entity';
import {
  inicioDelDiaOFalla,
  resolverTurno,
  turnoPedido,
} from './fleet-task-turno';
import {
  CambioDeTarea,
  FleetTaskBoardNotifier,
} from './fleet-task-board.notifier';
import { assertSinCambiosAjenos } from './fleet-task-board.errors';
import { valorLegible } from '../common/validation/etiquetas';
import { Attachment } from '../attachment/entities/attachment.entity';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import {
  assertDuenoSinCambios,
  ValoresDelDueno,
} from '../common/utils/conciliacion-de-documentos';

/** Fecha de calendario del cuerpo: `undefined` no se toca, `null` borra, un ISO se normaliza. */
function fechaDeCalendario(valor: string | null | undefined) {
  if (valor === null) return null;
  return valor ? normalizarFechaCalendario(new Date(valor)) : undefined;
}

/** Las tareas del plan de seguro se pagan por las cuotas de la póliza, nunca por acá. */
export const MOTIVO_SEGURO = 'El seguro se paga por sus cuotas';

export const esDeSeguro = (plan: MaintenancePlan | undefined | null): boolean =>
  plan?.documentKind === MaintenanceDocumentKind.INSURANCE;

/** Margen para el reloj del cliente al registrar «cuándo se hizo» (5 minutos). */
const MARGEN_FECHA_FUTURA_MS = 5 * 60 * 1000;

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
    private readonly pagos: CashDocumentPaymentService,
    // El planificador de taller (CU-105): una tarea que se cierra o cancela por fuera cierra su caso.
    @Optional() private readonly casos?: PlanningCaseCloser,
    // El tablero del panel (`fleet:task`): se avisa después de confirmar.
    @Optional() private readonly tablero?: FleetTaskBoardNotifier,
  ) {}

  /** Avisa al tablero del panel; nunca rompe la operación que ya se confirmó. */
  private async avisarAlTablero(
    distributorId: string,
    taskId: string,
    cambio: CambioDeTarea,
  ): Promise<void> {
    await this.tablero?.avisar(distributorId, taskId, cambio);
  }

  async create(
    dto: CreateFleetTaskV2Dto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const plan = await this.findPlanOrThrow(dto.planId, distributorId);
    const empleado = await this.assertSujetoCoherente(plan, dto, distributorId);
    this.assertDatosDelDocumento(plan, dto, empleado);
    if (dto.assigneeEmployeeId) {
      // 404 si es de otra distribuidora; 409 si está egresado.
      await this.employees.findActivo(dto.assigneeEmployeeId, distributorId);
    }

    const dueAt = dto.dueAt
      ? normalizarFechaCalendario(new Date(dto.dueAt))
      : null;
    const validFrom = dto.validFrom
      ? normalizarFechaCalendario(new Date(dto.validFrom))
      : null;
    this.assertVigenciaCoherente(plan, validFrom, dueAt);
    const pedido = turnoPedido(dto.scheduledAt);
    const scheduledAt =
      !pedido || pedido.tipo === 'borrar'
        ? null
        : pedido.tipo === 'instante'
          ? pedido.inicio
          : inicioDelDiaOFalla(pedido.dia);

    const task = this.tasks.create({
      planId: plan.planId,
      distributorId,
      carId: dto.carId ?? null,
      deliveryId: dto.deliveryId ?? null,
      employeeId: empleado?.employeeId ?? null,
      assigneeEmployeeId: dto.assigneeEmployeeId ?? null,
      status: MaintenanceTaskStatus.SCHEDULED,
      // Fecha de calendario: si el ISO trae hora (datepicker con hora local,
      // etc.), se normaliza a medianoche UTC para no correr el vencimiento a
      // otro día (revisión de vehículo en uso).
      dueAt,
      validFrom,
      dueKm: dto.dueKm ?? null,
      // Igual que en `update`: un día (o medianoche argentina) es el día argentino; con hora, ese instante.
      scheduledAt,
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

    let saved: MaintenanceTask;
    try {
      saved = await this.tasks.save(task);
      saved.plan = plan;
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }
    await this.avisarAlTablero(distributorId, saved.taskId, 'created');
    return saved;
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
      throw new NotFoundException('Tarea no encontrada');
    }
    return task;
  }

  async update(
    id: string,
    dto: UpdateFleetTaskDto,
    distributorId: string,
    userId: string | null = null,
    /** Lo propio del tablero (v2): el responsable y la precondición de la edición. */
    tablero: {
      assigneeEmployeeId?: string | null;
      expectedUpdatedAt?: Date;
    } = {},
  ): Promise<MaintenanceTask> {
    const dueAt = fechaDeCalendario(dto.dueAt);
    const validFrom = fechaDeCalendario(dto.validFrom);
    const pedido = turnoPedido(dto.scheduledAt);

    // Con la fila bloqueada (como `close` y `cancel`): una edición concurrente no
    // reabre ni pisa una tarea que ya se cerró.
    try {
      await withTransactionRetry(
        () =>
          this.tasks.manager.transaction(async (manager) => {
            const task = await this.bloquear(manager, id, distributorId);
            assertSinCambiosAjenos(task.updatedAt, tablero.expectedUpdatedAt);
            this.assertAbierta(task, true);
            task.plan = await manager
              .getRepository(MaintenancePlan)
              .findOneOrFail({ where: { planId: task.planId } });

            this.assertVigenciaCoherente(
              task.plan,
              validFrom === undefined ? task.validFrom : validFrom,
              dueAt === undefined ? task.dueAt : dueAt,
            );

            // El turno agendado y la ventana confirmada del planificador (CU-105) son
            // lo mismo: si el turno cambia de verdad, la ventana lo sigue (también el
            // bloqueo del despacho) o se cancela si se borra. Un turno igual al guardado
            // (el panel lo reenvía en cada edición) no toca nada.
            const turno = await resolverTurno(
              manager,
              this.casos,
              id,
              pedido,
              task.scheduledAt,
              userId,
            );

            if (
              tablero.assigneeEmployeeId &&
              tablero.assigneeEmployeeId !== task.assigneeEmployeeId
            ) {
              // Sólo si cambia (reenviar el mismo no vuelve a validar ni a bloquear
              // el legajo). 404 si es de otra distribuidora; 409 si está egresado.
              // Orden de locks: tarea → legajo; el egreso toma el legajo y no toca
              // tareas, así que no se cruzan (y la transacción reintenta un deadlock).
              await this.employees.findActivo(
                tablero.assigneeEmployeeId,
                distributorId,
                manager,
              );
            }

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
                scheduledAt: turno,
                assigneeEmployeeId: tablero.assigneeEmployeeId,
                details:
                  dto.details === undefined
                    ? undefined
                    : this.detalleValidado(task.plan, dto),
              }),
            );
            await manager.getRepository(MaintenanceTask).save(task);
          }),
        { context: 'tareas de flota' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }
    await this.avisarAlTablero(distributorId, id, 'updated');
    return this.findOne(id, distributorId);
  }

  /**
   * La tarea de la distribuidora con la fila bloqueada, dentro de la
   * transacción de quien llama: cerrar y cancelar se serializan, así que una
   * tarea no se cierra dos veces ni un cierre pisa a una cancelación.
   */
  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    const task = await manager
      .getRepository(MaintenanceTask)
      .createQueryBuilder('task')
      .setLock('pessimistic_write')
      .where('task.taskId = :id', { id })
      .andWhere('task.distributorId = :distributorId', { distributorId })
      .getOne();
    if (!task) {
      throw new NotFoundException('Tarea no encontrada');
    }
    return task;
  }

  /** CU-141: registrar que el mantenimiento/habilitación se hizo. */
  async close(
    id: string,
    dto: CloseFleetTaskDto,
    distributorId: string,
    pago?: PagoAlCerrar & { userId: string },
    /** La v2 responde 409 si la tarea ya está hecha o cancelada; la v1, 400. */
    { cerradaComoConflicto = false }: { cerradaComoConflicto?: boolean } = {},
  ): Promise<MaintenanceTask> {
    const performedAt = new Date(dto.performedAt);
    if (performedAt.getTime() > Date.now() + MARGEN_FECHA_FUTURA_MS) {
      throw new BadRequestException(
        'La fecha de realización no puede ser futura: registrá cuándo se hizo',
      );
    }
    const pagadoEn = pago
      ? pago.paidAt
        ? instanteValido(pago.paidAt, 'payment.paidAt')
        : new Date()
      : null;

    // El kilometraje del vehículo se sube con el del cierre, por el mismo
    // punto que usan las cargas de combustible: ninguno pisa al otro.
    let propuestasCerradas: MaintenanceWindowProposal[] = [];
    try {
      await this.tasks.manager.transaction(async (manager) => {
        const task = await this.bloquear(manager, id, distributorId);
        this.assertAbierta(task, cerradaComoConflicto);
        propuestasCerradas =
          (await this.casos?.cerrar(
            manager,
            { taskId: id },
            'La tarea se cerró por fuera del planificador',
          )) ?? [];
        // Cuenta también el kilometraje que la tarea ya traía guardado: la base
        // lo valida al pasar a «hecha» venga o no en el cierre.
        const kilometraje = dto.odometerKm ?? task.odometerKm;
        if (task.carId && kilometraje !== null && kilometraje !== undefined) {
          await this.assertOdometroMonotono(
            manager,
            task.carId,
            performedAt,
            kilometraje,
          );
        }

        task.performedAt = performedAt;
        task.odometerKm = dto.odometerKm ?? task.odometerKm;
        task.cost = dto.cost ?? task.cost;
        if (pago && !(task.cost && task.cost > 0)) {
          throw new BadRequestException(
            'Pago: la tarea no tiene costo para pagar; cargá el costo primero',
          );
        }
        task.provider = dto.provider ?? task.provider;
        task.notes = dto.notes ?? task.notes;
        task.status = MaintenanceTaskStatus.DONE;

        const guardada = await manager
          .getRepository(MaintenanceTask)
          .save(task);
        if (guardada.carId && dto.odometerKm !== undefined) {
          await this.carService.actualizarOdometro(
            manager,
            guardada.carId,
            dto.odometerKm,
          );
        }
        if (pago && pagadoEn) {
          await this.egresarPago(
            manager,
            guardada,
            pago.cashBoxId,
            pagadoEn,
            undefined,
            pago.userId,
          );
        }
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }
    await this.casos?.avisar(propuestasCerradas);
    await this.avisarAlTablero(distributorId, id, 'closed');
    return this.findOne(id, distributorId);
  }

  /**
   * Renueva un documento del legajo dentro de la transacción de una lectura: la
   * tarea actual queda hecha con el adjunto leído y la próxima vence en la fecha
   * leída. La licencia cuelga del perfil de reparto; el resto, del legajo.
   * Devuelve las propuestas del planificador que hay que avisar al confirmar la
   * transacción (`avisarCasosCerrados`).
   */
  async renovarDocumentoDesdeLectura(
    manager: EntityManager,
    employeeId: string,
    distributorId: string,
    datos: {
      documentKind: MaintenanceDocumentKind;
      vencimiento: string;
      fechaDelDocumento: string | null;
      taskId?: string;
      attachmentId: string;
      expected: ValoresDelDueno;
    },
  ): Promise<MaintenanceWindowProposal[]> {
    const empleado = await this.employees.findActivo(
      employeeId,
      distributorId,
      manager,
    );
    assertDuenoSinCambios(datos.expected, {
      documento: empleado.documentNumber,
      titular: `${empleado.firstName} ${empleado.lastName}`,
    });
    if (datos.vencimiento < diaArgentino()) {
      throw new BadRequestException(
        'Vencimiento: la fecha ya pasó; corregila o rechazá la propuesta',
      );
    }
    const perfiles = empleado.userId
      ? await this.deliveryService.findDeliveryIdsByUserIds(
          [empleado.userId],
          distributorId,
        )
      : [];
    const deliveryIds = perfiles.map((p) => p.deliveryId);
    const repo = manager.getRepository(MaintenanceTask);
    const consulta = repo
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .setLock('pessimistic_write', undefined, ['task'])
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere('plan.document_kind = :documentKind', {
        documentKind: datos.documentKind,
      })
      .andWhere(
        new Brackets((qb) => {
          qb.where('task.employee_id = :employeeId', { employeeId });
          if (deliveryIds.length > 0) {
            qb.orWhere('task.delivery_id IN (:...deliveryIds)', {
              deliveryIds,
            });
          }
        }),
      );
    if (datos.taskId) {
      consulta.andWhere('task.task_id = :taskId', { taskId: datos.taskId });
    } else {
      consulta.andWhere('task.status NOT IN (:...cerradas)', {
        cerradas: ESTADOS_CERRADOS,
      });
    }
    const candidatas = await consulta.getMany();
    if (candidatas.length === 0) {
      throw new NotFoundException('Tarea de documentación no encontrada');
    }
    if (candidatas.length > 1) {
      throw new BadRequestException(
        'Tarea de documentación: elegí cuál renovar porque hay más de una posible',
      );
    }
    const [tarea] = candidatas;
    if (ESTADOS_CERRADOS.includes(tarea.status)) {
      throw new ConflictException(
        `La tarea de documentación ya está ${tarea.status === MaintenanceTaskStatus.DONE ? 'hecha' : 'cancelada'}: elegí otra`,
      );
    }
    const dueAt = normalizarFechaCalendario(
      new Date(`${datos.vencimiento}T00:00:00.000Z`),
    );
    const validFrom = datos.fechaDelDocumento
      ? normalizarFechaCalendario(
          new Date(`${datos.fechaDelDocumento}T00:00:00.000Z`),
        )
      : null;
    this.assertVigenciaCoherente(tarea.plan, validFrom, dueAt);

    const adjunto = await manager.findOne(Attachment, {
      where: { attachmentId: datos.attachmentId, distributorId },
    });
    if (!adjunto) throw new NotFoundException('Adjunto no encontrado');
    const propuestas =
      (await this.casos?.cerrar(
        manager,
        { taskId: tarea.taskId },
        'La tarea se cerró por fuera del planificador',
      )) ?? [];

    tarea.status = MaintenanceTaskStatus.DONE;
    tarea.performedAt = new Date();
    await repo.save(tarea);
    // El archivo sigue siendo uno solo: esta fila apunta a la misma clave del storage.
    const adjuntos = manager.getRepository(MaintenanceTaskAttachment);
    await adjuntos.save(
      adjuntos.create({
        taskId: tarea.taskId,
        distributorId,
        storageKey: adjunto.storageKey,
        originalName: adjunto.originalName,
        mimeType: adjunto.mimeType,
        sizeBytes: adjunto.sizeBytes,
        uploadedByUserId: adjunto.uploadedByUserId,
      }),
    );
    await repo.save(
      repo.create({
        planId: tarea.planId,
        distributorId,
        employeeId: tarea.employeeId,
        carId: null,
        deliveryId: tarea.deliveryId,
        status: MaintenanceTaskStatus.SCHEDULED,
        validFrom,
        dueAt,
        dueKm: null,
        predictedDueAt: null,
        scheduledAt: null,
        performedAt: null,
        odometerKm: null,
        cost: tarea.cost,
        provider: tarea.provider,
        referenceNumber: tarea.referenceNumber,
        category: tarea.category,
        alertedAt: null,
        notes: tarea.notes,
        details:
          datos.documentKind === MaintenanceDocumentKind.PSYCHOPHYSICAL &&
          datos.fechaDelDocumento
            ? { examDate: datos.fechaDelDocumento }
            : tarea.details,
        cashMovementId: null,
        paidAt: null,
        paidAmount: null,
      }),
    );
    return propuestas;
  }

  /** Avisa las propuestas que cerró una renovación, ya confirmada la transacción. */
  async avisarCasosCerrados(
    propuestas: MaintenanceWindowProposal[],
  ): Promise<void> {
    await this.casos?.avisar(propuestas);
  }

  /**
   * API v2: registra el pago de una tarea hecha desde una caja de efectivo,
   * banco o billetera. Una sola vez por tarea (409 si ya está paga).
   */
  async pagar(
    id: string,
    dto: PayFleetTaskDto,
    distributorId: string,
    userId: string,
  ): Promise<MaintenanceTask> {
    const pagadoEn = instanteValido(dto.paidAt, 'paidAt');
    try {
      await this.tasks.manager.transaction(async (manager) => {
        const task = await this.bloquear(manager, id, distributorId);
        await this.egresarPago(
          manager,
          task,
          dto.cashBoxId,
          pagadoEn,
          dto.amount,
          userId,
        );
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }
    return this.findOne(id, distributorId);
  }

  /** Con la tarea ya bloqueada: el egreso de la caja y las marcas de pago. */
  private async egresarPago(
    manager: EntityManager,
    task: MaintenanceTask,
    cashBoxId: string,
    pagadoEn: Date,
    importe: number | undefined,
    userId: string,
  ): Promise<void> {
    if (task.status !== MaintenanceTaskStatus.DONE) {
      throw new ConflictException(
        'Sólo se paga una tarea hecha: cerrala primero',
      );
    }
    const completa = await manager
      .getRepository(MaintenanceTask)
      .findOneOrFail({
        where: { taskId: task.taskId },
        relations: {
          plan: true,
          car: true,
          employee: true,
          delivery: { user: true },
        },
      });
    if (esDeSeguro(completa.plan)) {
      throw new ConflictException(MOTIVO_SEGURO);
    }
    if (task.cashMovementId) {
      throw new ConflictException('La tarea ya está paga');
    }
    if (!task.cost || task.cost <= 0) {
      throw new ConflictException('La tarea no tiene un costo para pagar');
    }
    const monto = new Decimal(importe ?? task.cost);
    if (monto.lte(0)) {
      throw new BadRequestException('Importe: tiene que ser mayor que cero');
    }
    if (monto.gt(task.cost)) {
      throw new BadRequestException(
        'Importe: no puede superar el costo de la tarea',
      );
    }
    if (
      task.performedAt &&
      diaArgentino(pagadoEn) < diaArgentino(task.performedAt)
    ) {
      throw new BadRequestException(
        'Fecha de pago: no puede ser anterior a la fecha en que se hizo la tarea',
      );
    }
    const quien =
      completa.car?.carPatent ??
      (completa.employee
        ? `${completa.employee.lastName} ${completa.employee.firstName}`
        : completa.delivery?.user?.fullName) ??
      'sin vehículo ni chofer';
    const movimiento = await this.pagos.pagarDesdeUnaCaja(manager, {
      distributorId: task.distributorId,
      cashBoxId,
      amount: monto,
      systemCode: CashSystemCode.FLEET_MAINTENANCE,
      referenceType: CashReferenceType.MAINTENANCE_TASK,
      referenceId: task.taskId,
      description: `${completa.plan.name} — ${quien}`,
      userId,
    });
    task.cashMovementId = movimiento.movementId;
    task.paidAt = pagadoEn;
    task.paidAmount = monto.toNumber();
    await manager.getRepository(MaintenanceTask).save(task);
  }

  /**
   * El kilometraje de un cierre tiene que encajar entre el de la tarea hecha
   * justo antes y el de la hecha justo después en el mismo vehículo. La base lo
   * exige con CHK_maintenance_task_odometro_monotono.
   */
  private async assertOdometroMonotono(
    manager: EntityManager,
    carId: string,
    performedAt: Date,
    odometerKm: number,
  ): Promise<void> {
    const vecina = (comparador: '<=' | '>', orden: 'DESC' | 'ASC') =>
      manager
        .getRepository(MaintenanceTask)
        .createQueryBuilder('t')
        .where(
          `t.car_id = :carId AND t.status = :hecha AND t.odometer_km IS NOT NULL AND t.performed_at ${comparador} :performedAt`,
          { carId, hecha: MaintenanceTaskStatus.DONE, performedAt },
        )
        .orderBy('t.performed_at', orden)
        .addOrderBy('t.odometer_km', orden)
        .getOne();
    const anterior = await vecina('<=', 'DESC');
    const siguiente = await vecina('>', 'ASC');
    if (anterior?.odometerKm != null && odometerKm < anterior.odometerKm) {
      throw new BadRequestException(
        `Kilometraje: es menor que el de la tarea anterior del vehículo (${anterior.odometerKm} km)`,
      );
    }
    if (siguiente?.odometerKm != null && odometerKm > siguiente.odometerKm) {
      throw new BadRequestException(
        `Kilometraje: es mayor que el de una tarea posterior del vehículo (${siguiente.odometerKm} km; corregí la fecha o el kilometraje)`,
      );
    }
  }

  async cancel(
    id: string,
    dto: CancelFleetTaskDto,
    distributorId: string,
  ): Promise<MaintenanceTask> {
    let propuestasCerradas: MaintenanceWindowProposal[] = [];
    await this.tasks.manager.transaction(async (manager) => {
      const task = await this.bloquear(manager, id, distributorId);
      this.assertAbierta(task);
      propuestasCerradas =
        (await this.casos?.cerrar(
          manager,
          { taskId: id },
          'La tarea se canceló por fuera del planificador',
        )) ?? [];

      task.status = MaintenanceTaskStatus.CANCELLED;
      if (dto.notes) {
        task.notes = task.notes
          ? `${task.notes}\n\nCancelada: ${dto.notes}`
          : `Cancelada: ${dto.notes}`;
      }
      await manager.getRepository(MaintenanceTask).save(task);
    });
    await this.casos?.avisar(propuestasCerradas);
    await this.avisarAlTablero(distributorId, id, 'cancelled');
    return this.findOne(id, distributorId);
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
      throw new NotFoundException('Chofer no encontrado');
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
        'Vencimiento: la habilitación necesita la fecha de vencimiento',
      );
    }
    if (validFrom && dueAt && validFrom.getTime() > dueAt.getTime()) {
      throw new BadRequestException(
        'Válido desde: el inicio de la vigencia no puede ser posterior al vencimiento',
      );
    }
  }

  /** `comoConflicto`: la edición concurrente de una tarea ya cerrada es 409 (cerrar/cancelar siguen en 400). */
  private assertAbierta(task: MaintenanceTask, comoConflicto = false): void {
    if (ESTADOS_CERRADOS.includes(task.status)) {
      const mensaje = `La tarea ya está ${task.status === MaintenanceTaskStatus.DONE ? 'hecha' : 'cancelada'}`;
      throw comoConflicto
        ? new ConflictException(mensaje)
        : new BadRequestException(mensaje);
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
      throw new NotFoundException('Plan no encontrado');
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
          'Un plan de vehículo necesita el vehículo (y no el chofer ni el empleado)',
        );
      }
      await this.carService.findOne(dto.carId, distributorId); // 404 si no existe/no es de esta distribuidora
      return null;
    }

    if (plan.subject === MaintenanceSubject.EMPLOYEE) {
      if (!dto.employeeId || dto.carId || dto.deliveryId) {
        throw new BadRequestException(
          'Un plan de personal necesita el empleado (y no el vehículo ni el chofer)',
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
          `El plan «${plan.name}» no aplica a la categoría del puesto del empleado (${valorLegible(empleado.position.category)})`,
        );
      }
      return empleado;
    }

    if (!dto.deliveryId || dto.carId || dto.employeeId) {
      throw new BadRequestException(
        'Un plan de chofer necesita el chofer (y no el vehículo ni el empleado)',
      );
    }
    const delivery = await this.deliveryService.findOne(dto.deliveryId);
    if (delivery.distributorId !== distributorId) {
      throw new NotFoundException('Chofer no encontrado');
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
          'Vencimiento: el vencimiento del documento es obligatorio',
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
