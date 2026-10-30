import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { Car, FleetStatus } from '../../car/entities/car.entity';
import { CarService } from '../../car/car.service';
import { VehicleAssignmentService } from '../../car/vehicle-assignment.service';
import { errorMessage } from '../../common/errors/error-message';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import {
  diaArgentino,
  minutosDelDiaArgentino,
} from '../../common/utils/dias-argentina';
import { DeliveryService } from '../../delivery/delivery.service';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import {
  ProcesoVigente,
  ProcessConfigService,
} from '../../distributor/process-config.service';
import { ValoresDeProceso } from '../../distributor/process-config';
import {
  calcularEstadoDeVencimiento,
  ExpirationStatus,
} from '../domain/expiration-status';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
  PlanningEscalationReason,
  PlanningWindowSource,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceCriticality,
  MaintenanceDocumentKind,
  MaintenancePlan,
} from '../entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../entities/maintenance-task.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import {
  ConsumoDelVehiculo,
  MaintenanceForecastService,
  TareaProyectada,
} from './maintenance-forecast.service';
import { MaintenancePlannerNotifier } from './maintenance-planner-notifier';
import { VehicleUsageFeedService } from './vehicle-usage-feed.service';
import {
  ContextoDePlanificacion,
  marcarOcupado,
  PlannerContextService,
} from './planner-context.service';
import { diasDeLaMascara, FERIADOS_AR } from './domain/dias-de-taller';
import { ProyeccionDeVencimiento } from './domain/proyeccion-de-vencimiento';
import { enumerarVentanas, evaluarVentanas } from './domain/ventanas-de-taller';

const MS_POR_DIA = 86_400_000;
const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];
const CASOS_ABIERTOS = [
  PlanningCaseStatus.NEGOTIATING,
  PlanningCaseStatus.AWAITING_CONFIRMATION,
  PlanningCaseStatus.ESCALATED,
];

/**
 * Las habilitaciones que se resuelven en un taller. El seguro es un trámite
 * (se renueva con la aseguradora) y no tiene ventana de taller.
 */
const TIPOS_CON_TALLER: ReadonlyArray<MaintenanceDocumentKind | null> = [
  null,
  MaintenanceDocumentKind.SERVICE,
  MaintenanceDocumentKind.VTV,
  MaintenanceDocumentKind.GENERIC,
];

export const requiereTaller = (plan: MaintenancePlan): boolean =>
  TIPOS_CON_TALLER.includes(plan.documentKind);

/** Lo que dejó una corrida del planificador para una distribuidora. */
export interface ResumenDeCorrida {
  distributorId: string;
  vehiculos: number;
  prediccionesActualizadas: number;
  propuestas: number;
  escaladas: number;
  reiteradas: number;
  vehiculosFueraDeServicio: number;
  enObservacion: number;
}

/** Un vehículo con sus tareas proyectadas (la pantalla «próximos vencimientos»). */
export interface VencimientosDeVehiculo {
  car: Car;
  consumo: ConsumoDelVehiculo | null;
  items: Array<{
    task: MaintenanceTask;
    proyeccion: ProyeccionDeVencimiento;
    porVencer: boolean;
    caso: MaintenancePlanningCase | null;
  }>;
  /** Próxima ventana acordada o propuesta, si hay. */
  proximaVentana: { start: Date; end: Date; estado: PlanningCaseStatus } | null;
}

export interface CasoCompleto extends MaintenancePlanningCase {
  proposals: MaintenanceWindowProposal[];
}

export interface FiltroDeCasos {
  status?: PlanningCaseStatus;
  carId?: string;
  /** Sólo los que esperan al administrador: escalados o a confirmar. */
  pendientesDelAdmin?: boolean;
  limit: number;
  offset: number;
}

const isAbierto = (status: PlanningCaseStatus): boolean =>
  CASOS_ABIERTOS.includes(status);

export interface ResolucionDelAdmin {
  /** Confirma aunque la ventana deje la zona bajo el mínimo (el administrador decide). */
  ignoreCoverage?: boolean;
  windowStart?: Date;
  windowEnd?: Date;
  provider?: string;
  cost?: number;
  notes?: string;
}

export interface RechazoDelChofer {
  reason: string;
  alternative?: { start: Date; end: Date };
}

const ESTADO_UNICO_VIOLADO = '23505';

@Injectable()
export class MaintenancePlannerService {
  private readonly logger = new Logger(MaintenancePlannerService.name);

  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    @InjectRepository(MaintenancePlanningCase)
    private readonly cases: Repository<MaintenancePlanningCase>,
    @InjectRepository(MaintenanceWindowProposal)
    private readonly proposals: Repository<MaintenanceWindowProposal>,
    private readonly dataSource: DataSource,
    private readonly carService: CarService,
    private readonly assignments: VehicleAssignmentService,
    private readonly deliveries: DeliveryService,
    private readonly processConfig: ProcessConfigService,
    private readonly forecast: MaintenanceForecastService,
    private readonly contexto: PlannerContextService,
    private readonly notifier: MaintenancePlannerNotifier,
    private readonly feed: VehicleUsageFeedService,
  ) {}

  /** Los parámetros vigentes del planificador de la distribuidora. */
  parametros(distributorId: string): Promise<ValoresDeProceso> {
    return this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.FLEET_PLANNER,
    );
  }

  /** Los parámetros con su esquema, para la pantalla de configuración. */
  parametrosVigentes(distributorId: string): Promise<ProcesoVigente> {
    return this.processConfig.vigentes(
      distributorId,
      ConfigurableProcess.FLEET_PLANNER,
    );
  }

  /** Cambia sólo los parámetros que vienen; los demás conservan su valor. */
  async cambiarParametros(
    distributorId: string,
    cambios: Record<string, number | undefined>,
    userId: string,
  ): Promise<ProcesoVigente> {
    const actuales = await this.parametros(distributorId);
    const nuevos: Record<string, number> = { ...actuales };
    for (const [clave, valor] of Object.entries(cambios)) {
      if (valor !== undefined) nuevos[clave] = valor;
    }
    return this.processConfig.guardar(
      distributorId,
      ConfigurableProcess.FLEET_PLANNER,
      nuevos,
      userId,
    );
  }

  // ───────────────────────── corrida diaria ─────────────────────────

  /**
   * CU-105, pasos 2 a 10, para una distribuidora: estima el consumo, proyecta
   * los vencimientos, guarda `predicted_due_at`, deja fuera de servicio a los
   * vehículos con una habilitación bloqueante vencida y abre el caso de cada
   * tarea que entró en su anticipación. Idempotente: una tarea con un caso
   * abierto o con un taller ya programado no se vuelve a planificar.
   */
  async ejecutar(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<ResumenDeCorrida> {
    const params = await this.parametros(distributorId);
    // El uso real se pone al día antes de estimar con él (idempotente).
    try {
      await this.feed.alimentar(distributorId, ahora);
    } catch (error) {
      this.logger.warn(
        `No se pudo actualizar el uso de la flota (${distributorId}): ${errorMessage(error)}`,
      );
    }
    const cars = await this.carService.findAll(distributorId);
    const consumos = await this.forecast.consumos(
      distributorId,
      cars,
      params,
      ahora,
    );
    const abiertas = await this.tareasAbiertas(distributorId);
    const porVehiculo = new Map(cars.map((c) => [c.carId, c]));
    const proyectadas: TareaProyectada[] = [];
    for (const task of abiertas) {
      const car = porVehiculo.get(task.carId as string);
      if (!car) continue;
      const consumo = consumos.get(car.carId) ?? null;
      proyectadas.push({
        task,
        consumo,
        proyeccion: this.forecast.proyectar(task, car, consumo, ahora),
      });
    }

    const resumen: ResumenDeCorrida = {
      distributorId,
      vehiculos: cars.length,
      prediccionesActualizadas:
        await this.forecast.guardarPredicciones(proyectadas),
      propuestas: 0,
      escaladas: 0,
      reiteradas: 0,
      vehiculosFueraDeServicio: await this.apagarVencidos(
        distributorId,
        proyectadas,
        porVehiculo,
        ahora,
      ),
      enObservacion: proyectadas.filter(
        (p) => p.proyeccion.enObservacion && requiereTaller(p.task.plan),
      ).length,
    };
    // Los que ya quedaron fuera de servicio no cuentan para la cobertura de la zona.
    const activos = cars.filter((c) => c.fleetStatus === FleetStatus.ACTIVE);

    const abiertos = await this.cases.find({
      where: { distributorId, status: In(CASOS_ABIERTOS) },
      relations: { car: true, task: { plan: true } },
      withDeleted: true,
    });
    const conCaso = new Set(abiertos.map((c) => c.taskId));
    const hoy = diaArgentino(ahora);
    for (const caso of abiertos) {
      try {
        if (this.reiterar(caso, hoy)) resumen.reiteradas += 1;
      } catch (error) {
        this.logger.error(
          `Planificador: no se pudo revisar el caso ${caso.caseId}: ${errorMessage(error)}`,
        );
      }
    }
    for (const caso of abiertos) {
      if (caso.status !== PlanningCaseStatus.NEGOTIATING) continue;
      try {
        await this.revisarChofer(caso, params, ahora);
      } catch (error) {
        this.logger.error(
          `Planificador: no se pudo revisar el chofer del caso ${caso.caseId}: ${errorMessage(error)}`,
        );
      }
    }

    const candidatas = proyectadas.filter((p) =>
      this.esCandidata(p, conCaso, params, ahora),
    );
    if (candidatas.length === 0) return resumen;

    const ctx = await this.contexto.cargar(
      distributorId,
      activos,
      params,
      ahora,
    );
    for (const p of candidatas) {
      const car = porVehiculo.get(p.task.carId as string) as Car;
      try {
        const resultado = await this.planificar(p, car, ctx, params, ahora);
        if (resultado === 'propuesta') resumen.propuestas += 1;
        if (resultado === 'escalado') resumen.escaladas += 1;
      } catch (error) {
        this.logger.error(
          `Planificador: falló la tarea ${p.task.taskId} (${distributorId}): ${errorMessage(error)}`,
        );
      }
    }
    return resumen;
  }

  /**
   * Lo que sigue pendiente del administrador se le recuerda en cada corrida,
   * sin correo y una sola vez por día (el primer aviso del día es el del
   * escalamiento mismo): el escalado y el acordado con el chofer. Un acordado
   * cuya ventana ya pasó lo dice, porque no se puede confirmar.
   */
  private reiterar(caso: MaintenancePlanningCase, hoy: string): boolean {
    const ctx = {
      planName: caso.task.plan.name,
      patent: caso.car.carPatent ?? '-',
    };
    if (caso.status === PlanningCaseStatus.ESCALATED) {
      if (caso.escalatedAt && diaArgentino(caso.escalatedAt) === hoy)
        return false;
      this.notifier.alAdminEscalado(caso, ctx, hoy, true);
      return true;
    }
    if (caso.status === PlanningCaseStatus.AWAITING_CONFIRMATION) {
      this.notifier.alAdminAcordadoPendiente(caso, ctx, hoy);
      return true;
    }
    return false;
  }

  /**
   * El chofer se toma de la asignación vigente: si el vehículo cambió de manos,
   * la propuesta pendiente del anterior se cierra con aviso y se le ofrece al
   * chofer actual; si quedó sin chofer, el caso se escala.
   */
  private async revisarChofer(
    caso: MaintenancePlanningCase,
    params: ValoresDeProceso,
    ahora: Date,
  ): Promise<void> {
    const actual = await this.assignments.choferDelVehiculoEn(
      caso.carId,
      caso.distributorId,
      ahora,
    );
    if (actual === caso.deliveryId) return;
    const cerradas: MaintenanceWindowProposal[] = [];
    let siguiente: MaintenanceWindowProposal | null = null;
    await this.dataSource.transaction(async (manager) => {
      const fresco = await this.bloquearCaso(manager, caso.caseId);
      if (fresco.status !== PlanningCaseStatus.NEGOTIATING) return;
      cerradas.push(...(await this.cerrarPendientes(manager, fresco)));
      fresco.deliveryId = actual;
      if (!actual) {
        this.marcarEscalado(fresco, PlanningEscalationReason.NO_DRIVER, ahora);
        await manager.getRepository(MaintenancePlanningCase).save(fresco);
      } else {
        siguiente = await this.ofrecerSiguiente(manager, fresco, params, ahora);
      }
      Object.assign(caso, fresco);
    });
    await this.avisarCierres(cerradas, 'cancelled');
    const ctx = await this.contextoDelAviso(caso);
    if (siguiente && actual) {
      await this.notifier.propuestaAlChofer(
        await this.deliveries.findOne(actual),
        siguiente,
        ctx,
        params.driverEmail === 1,
      );
    } else if (caso.status === PlanningCaseStatus.ESCALATED) {
      this.notifier.alAdminEscalado(caso, ctx, diaArgentino(ahora), false);
    }
  }

  private esCandidata(
    p: TareaProyectada,
    conCaso: Set<string>,
    params: ValoresDeProceso,
    ahora: Date,
  ): boolean {
    const { task, proyeccion } = p;
    if (!requiereTaller(task.plan) || !proyeccion.fecha) return false;
    if (conCaso.has(task.taskId)) return false;
    if (task.scheduledAt && task.scheduledAt.getTime() > ahora.getTime()) {
      return false;
    }
    const anticipacion = task.plan.leadTimeDays * MS_POR_DIA;
    const porDias =
      proyeccion.fecha.getTime() <= ahora.getTime() + anticipacion;
    // La anticipación por kilometraje: faltan pocos km aunque la fecha esté lejos.
    const porKm =
      params.anticipationKm > 0 &&
      proyeccion.kmFaltantes !== null &&
      proyeccion.kmFaltantes <= params.anticipationKm;
    return porDias || porKm;
  }

  private tareasAbiertas(distributorId: string): Promise<MaintenanceTask[]> {
    return this.tasks
      .createQueryBuilder('t')
      .innerJoinAndSelect('t.plan', 'plan')
      .where('t.distributor_id = :distributorId', { distributorId })
      .andWhere('t.car_id IS NOT NULL')
      .andWhere('t.status NOT IN (:...cerrados)', {
        cerrados: ESTADOS_CERRADOS,
      })
      .getMany();
  }

  /**
   * Paso 12: un vehículo con una habilitación bloqueante vencida (por fecha o
   * por haber llegado al kilometraje) queda fuera de servicio, sin esperar
   * ninguna confirmación, y se le libera el chofer como en un siniestro (si el
   * chofer está en plena entrega la asignación se mantiene y el despacho ya lo
   * excluye). Es lo primero de la corrida: lo que sigue cuenta la cobertura sin él.
   */
  private async apagarVencidos(
    distributorId: string,
    proyectadas: readonly TareaProyectada[],
    porVehiculo: Map<string, Car>,
    ahora: Date,
  ): Promise<number> {
    const vencidas = new Map<string, MaintenanceTask>();
    for (const { task, proyeccion } of proyectadas) {
      if (task.plan.criticality !== MaintenanceCriticality.BLOCKING) continue;
      const porFecha =
        calcularEstadoDeVencimiento(
          task.dueAt,
          task.plan.leadTimeDays,
          ahora,
        ) === ExpirationStatus.EXPIRED;
      const porKm =
        proyeccion.kmFaltantes !== null && proyeccion.kmFaltantes <= 0;
      if ((porFecha || porKm) && task.carId) vencidas.set(task.carId, task);
    }
    let apagados = 0;
    for (const [carId, task] of vencidas) {
      const car = porVehiculo.get(carId);
      if (!car || car.fleetStatus !== FleetStatus.ACTIVE) continue;
      try {
        await this.dataSource.transaction(async (manager) => {
          await this.carService.cambiarEstadoDeFlota(
            manager,
            carId,
            distributorId,
            FleetStatus.GROUNDED,
            FleetStatus.ACTIVE,
          );
          await this.assignments.liberarDelVehiculo(carId, manager, {
            motivo: `Liberado automáticamente: el vehículo quedó fuera de servicio por «${task.plan.name}» vencida.`,
          });
        });
        car.fleetStatus = FleetStatus.GROUNDED;
        apagados += 1;
        this.notifier.alAdminVehiculoFueraDeServicio(
          distributorId,
          carId,
          { planName: task.plan.name, patent: car.carPatent ?? '-' },
          diaArgentino(ahora),
        );
      } catch (error) {
        this.logger.warn(
          `No se pudo dejar fuera de servicio al vehículo ${carId}: ${errorMessage(error)}`,
        );
      }
    }
    return apagados;
  }

  // ───────────────────────── planificar una tarea ─────────────────────────

  /**
   * Pasos 5 a 7 y 10 para una tarea: evalúa las ventanas, abre el caso y le
   * ofrece la primera al chofer, o lo escala si no hay con quién negociar o
   * con qué ventana. `antes` corre en la misma transacción, antes de abrir el
   * caso (re-planificar cancela el anterior ahí, para que sea todo o nada).
   */
  private async planificar(
    p: TareaProyectada,
    car: Car,
    ctx: ContextoDePlanificacion,
    params: ValoresDeProceso,
    ahora: Date,
    antes?: (manager: EntityManager) => Promise<void>,
  ): Promise<'propuesta' | 'escalado' | 'omitido'> {
    const { task, proyeccion } = p;
    const proyectado = proyeccion.fecha as Date;
    const candidatas = enumerarVentanas({
      hoy: ahora,
      proyectado,
      minLeadDays: params.minLeadDays,
      horizonDays: params.horizonDays,
      workshopStartHour: params.workshopStartHour,
      workshopEndHour: params.workshopEndHour,
      workshopDays: params.workshopDays,
    });
    const zona = ctx.zonaDelVehiculo.get(car.carId) ?? null;
    const demanda = await ctx.demandaDe(zona);
    const evaluacion = evaluarVentanas(
      candidatas,
      demanda,
      ctx.unidadesDe(car.carId),
      params.minVehiclesPerZone,
      params.topNWindows,
    );

    const deliveryId = await this.assignments.choferDelVehiculoEn(
      car.carId,
      task.distributorId,
      ahora,
    );
    let motivo: PlanningEscalationReason | null = null;
    if (candidatas.length === 0) {
      motivo = PlanningEscalationReason.NO_WINDOWS;
    } else if (evaluacion.ofrecidas === 0) {
      motivo = PlanningEscalationReason.COVERAGE;
    } else if (!deliveryId) {
      motivo = PlanningEscalationReason.NO_DRIVER;
    }

    try {
      const { caso, propuesta } = await this.dataSource.transaction(
        async (manager) => {
          if (antes) await antes(manager);
          const nuevo = manager.getRepository(MaintenancePlanningCase).create({
            distributorId: task.distributorId,
            taskId: task.taskId,
            carId: car.carId,
            deliveryId,
            status: PlanningCaseStatus.NEGOTIATING,
            projectedDueAt: proyectado,
            evaluatedWindows: evaluacion.evaluadas,
            openedAt: ahora,
          });
          if (motivo) this.marcarEscalado(nuevo, motivo, ahora);
          const guardado = await manager
            .getRepository(MaintenancePlanningCase)
            .save(nuevo);
          const primera = motivo
            ? null
            : await this.ofrecerSiguiente(manager, guardado, params, ahora);
          return { caso: guardado, propuesta: primera };
        },
      );
      // Lo ofrecido reserva el día en el contexto de la corrida: la tarea que
      // sigue (otro vehículo de la misma zona) ya lo cuenta como ocupado.
      if (propuesta) {
        marcarOcupado(ctx.ocupadosPorDia, car.carId, propuesta.windowStart);
      }
      const ctxAviso = {
        planName: task.plan.name,
        patent: car.carPatent ?? '-',
      };
      if (propuesta && caso.deliveryId) {
        const delivery = await this.deliveries.findOne(caso.deliveryId);
        await this.notifier.propuestaAlChofer(
          delivery,
          propuesta,
          ctxAviso,
          params.driverEmail === 1,
        );
      }
      if (caso.status === PlanningCaseStatus.ESCALATED) {
        this.notifier.alAdminEscalado(
          caso,
          ctxAviso,
          diaArgentino(ahora),
          false,
        );
        return 'escalado';
      }
      return 'propuesta';
    } catch (error) {
      if ((error as { code?: string }).code === ESTADO_UNICO_VIOLADO) {
        return 'omitido'; // otra corrida abrió el caso de esta tarea
      }
      throw error;
    }
  }

  private marcarEscalado(
    caso: MaintenancePlanningCase,
    motivo: PlanningEscalationReason,
    ahora: Date,
  ): void {
    caso.status = PlanningCaseStatus.ESCALATED;
    caso.escalationReason = motivo;
    caso.escalatedAt = ahora;
  }

  /**
   * Ofrece la ventana siguiente de la lista del caso (la primera que todavía
   * no se le ofreció y no empezó) con la vigencia configurada, al chofer que
   * tiene hoy el vehículo. Sin más ventanas, o sin chofer, escala el caso.
   * Corre dentro de la transacción de quien llama, con el caso bloqueado.
   */
  private async ofrecerSiguiente(
    manager: EntityManager,
    caso: MaintenancePlanningCase,
    params: ValoresDeProceso,
    ahora: Date,
  ): Promise<MaintenanceWindowProposal | null> {
    const actual = await this.assignments.choferDelVehiculoEn(
      caso.carId,
      caso.distributorId,
      ahora,
    );
    caso.deliveryId = actual;
    if (!actual) {
      this.marcarEscalado(caso, PlanningEscalationReason.NO_DRIVER, ahora);
      await manager.getRepository(MaintenancePlanningCase).save(caso);
      return null;
    }
    const repo = manager.getRepository(MaintenanceWindowProposal);
    const previas = await repo.find({ where: { caseId: caso.caseId } });
    const rank = previas.reduce((max, p) => Math.max(max, p.rank), 0) + 1;
    // Una ventana cancelada (se cerró porque cambió el chofer) puede ofrecerse de nuevo.
    const yaOfrecidas = new Set(
      previas
        .filter((p) => p.status !== WindowProposalStatus.CANCELLED)
        .map((p) => p.windowStart.getTime()),
    );

    for (const ventana of caso.evaluatedWindows.filter((w) => w.offered)) {
      const inicio = new Date(ventana.start);
      if (inicio.getTime() <= ahora.getTime()) continue;
      if (yaOfrecidas.has(inicio.getTime())) continue;
      const vence = Math.min(
        ahora.getTime() + params.proposalTtlHours * 3_600_000,
        inicio.getTime(),
      );
      return repo.save(
        repo.create({
          taskId: caso.taskId,
          caseId: caso.caseId,
          distributorId: caso.distributorId,
          deliveryId: actual,
          windowStart: inicio,
          windowEnd: new Date(ventana.end),
          rank,
          status: WindowProposalStatus.PENDING,
          expiresAt: new Date(vence),
          respondedAt: null,
          rejectionReason: null,
          altWindowStart: null,
          altWindowEnd: null,
        }),
      );
    }
    this.marcarEscalado(caso, PlanningEscalationReason.EXHAUSTED, ahora);
    await manager.getRepository(MaintenancePlanningCase).save(caso);
    return null;
  }

  // ───────────────────── vencimiento de propuestas ─────────────────────

  /**
   * Cierra las propuestas cuya vigencia pasó sin respuesta y ofrece la
   * ventana siguiente; sin más ventanas, escala. Devuelve cuántas venció.
   */
  async vencerPropuestas(ahora: Date = new Date()): Promise<number> {
    const vencidas = await this.proposals.find({
      where: {
        status: WindowProposalStatus.PENDING,
        expiresAt: LessThanOrEqual(ahora),
      },
      select: { proposalId: true, distributorId: true },
    });
    let n = 0;
    for (const { proposalId, distributorId } of vencidas) {
      try {
        const params = await this.parametros(distributorId);
        if (await this.vencer(proposalId, params, ahora)) n += 1;
      } catch (error) {
        this.logger.error(
          `Propuesta ${proposalId}: no se pudo vencer: ${errorMessage(error)}`,
        );
      }
    }
    return n;
  }

  private async vencer(
    proposalId: string,
    params: ValoresDeProceso,
    ahora: Date,
  ): Promise<boolean> {
    const salida = await this.dataSource.transaction(async (manager) => {
      const propuesta = await manager
        .getRepository(MaintenanceWindowProposal)
        .findOne({ where: { proposalId } });
      if (!propuesta) return null;
      const caso = await this.bloquearCaso(manager, propuesta.caseId);
      const vigente = await manager
        .getRepository(MaintenanceWindowProposal)
        .findOneOrFail({ where: { proposalId } });
      if (
        vigente.status !== WindowProposalStatus.PENDING ||
        vigente.expiresAt.getTime() > ahora.getTime()
      ) {
        return null;
      }
      vigente.status = WindowProposalStatus.EXPIRED;
      await manager.getRepository(MaintenanceWindowProposal).save(vigente);
      const siguiente = await this.ofrecerSiguiente(
        manager,
        caso,
        params,
        ahora,
      );
      return { caso, vencida: vigente, siguiente };
    });
    if (!salida) return false;
    await this.despuesDeCerrar(
      salida.caso,
      salida.vencida,
      salida.siguiente,
      'expired',
      ahora,
      params.driverEmail === 1,
    );
    return true;
  }

  /** Avisos que siguen a cerrar una propuesta y ofrecer la próxima (o escalar). */
  private async despuesDeCerrar(
    caso: MaintenancePlanningCase,
    cerrada: MaintenanceWindowProposal,
    siguiente: MaintenanceWindowProposal | null,
    motivo: 'expired' | 'cancelled',
    ahora: Date,
    correo: boolean,
  ): Promise<void> {
    const delivery = await this.deliveries.findOne(cerrada.deliveryId);
    this.notifier.propuestaCerrada(delivery.userId, cerrada.proposalId, motivo);
    const ctx = await this.contextoDelAviso(caso);
    if (siguiente) {
      await this.notifier.propuestaAlChofer(delivery, siguiente, ctx, correo);
    } else if (caso.status === PlanningCaseStatus.ESCALATED) {
      await this.avisarEscalado(caso, delivery, ahora);
    }
  }

  /** El caso pasó al administrador: se le avisa a él (con correo la primera vez) y al chofer, para que la app lo saque de la lista. */
  private async avisarEscalado(
    caso: MaintenancePlanningCase,
    delivery: Delivery | null,
    ahora: Date,
  ): Promise<void> {
    const ctx = await this.contextoDelAviso(caso);
    this.notifier.alAdminEscalado(caso, ctx, diaArgentino(ahora), false);
    if (delivery) this.notifier.escaladoAlChofer(delivery, caso, ctx);
  }

  private async contextoDelAviso(caso: MaintenancePlanningCase) {
    const task = await this.tasks.findOneOrFail({
      where: { taskId: caso.taskId },
      relations: { plan: true, car: true },
      withDeleted: true,
    });
    return {
      planName: task.plan.name,
      patent: task.car?.carPatent ?? '-',
    };
  }

  // ───────────────────────── lado del chofer ─────────────────────────

  /** Las propuestas del chofer: la vigente primero, después el historial. */
  async propuestasDelChofer(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<[MaintenanceWindowProposal[], number]> {
    const delivery = await this.deliveries.findOneByUserId(userId);
    // La vigente (la que espera respuesta) primero; después, de la más próxima a la más lejana.
    const qb = this.proposals
      .createQueryBuilder('p')
      .innerJoinAndSelect('p.task', 'task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoinAndSelect('task.car', 'car')
      .innerJoinAndSelect('p.planningCase', 'planningCase')
      .withDeleted()
      .where('p.delivery_id = :deliveryId', {
        deliveryId: delivery.deliveryId,
      })
      .addSelect("CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END", 'orden');
    const total = await qb.getCount();
    const data = await qb
      .orderBy('orden', 'ASC')
      .addOrderBy('p.windowStart', 'ASC')
      .addOrderBy('p.rank', 'ASC')
      .limit(limit)
      .offset(offset)
      .getMany();
    return [data, total];
  }

  /** Horario y días de taller que la app del chofer usa para validar su ventana alternativa. */
  async ajustesParaElChofer(
    userId: string,
    ahora: Date = new Date(),
  ): Promise<{
    workshopStartHour: number;
    workshopEndHour: number;
    workshopDays: number[];
    holidays: string[];
    minLeadDays: number;
    horizonDays: number;
    proposalTtlHours: number;
  }> {
    const delivery = await this.deliveries.findOneByUserId(userId);
    const params = await this.parametros(delivery.distributorId);
    const hoy = diaArgentino(ahora);
    return {
      workshopStartHour: params.workshopStartHour,
      workshopEndHour: params.workshopEndHour,
      workshopDays: diasDeLaMascara(params.workshopDays),
      holidays: [...FERIADOS_AR].filter((d) => d >= hoy).sort(),
      minLeadDays: params.minLeadDays,
      horizonDays: params.horizonDays,
      proposalTtlHours: params.proposalTtlHours,
    };
  }

  async propuestaDelChofer(
    userId: string,
    proposalId: string,
  ): Promise<MaintenanceWindowProposal> {
    const delivery = await this.deliveries.findOneByUserId(userId);
    const propuesta = await this.proposals.findOne({
      where: { proposalId, deliveryId: delivery.deliveryId },
      relations: { task: { plan: true, car: true }, planningCase: true },
      withDeleted: true,
    });
    if (!propuesta) {
      throw new NotFoundException(`Propuesta ${proposalId} no encontrada`);
    }
    return propuesta;
  }

  /**
   * 409 si poner el vehículo en el taller ese día deja su zona bajo el mínimo
   * de unidades: se cuentan los talleres programados, los acordados a
   * confirmar y las propuestas que esperan respuesta de los demás.
   */
  private async verificarCobertura(
    distributorId: string,
    carId: string,
    inicio: Date,
    ahora: Date,
  ): Promise<void> {
    const params = await this.parametros(distributorId);
    const cars = (await this.carService.findAll(distributorId)).filter(
      (c) => c.fleetStatus === FleetStatus.ACTIVE,
    );
    const ctx = await this.contexto.cargar(distributorId, cars, params, ahora);
    const quedan = ctx.unidadesDe(carId)(diaArgentino(inicio));
    if (quedan !== null && quedan < params.minVehiclesPerZone) {
      throw new ConflictException(
        `Esa ventana deja la zona de cobertura del vehículo con ${quedan} unidad(es), por debajo del mínimo de ${params.minVehiclesPerZone}: otro vehículo de la zona ya tiene el taller ese día`,
      );
    }
  }

  async aceptar(
    userId: string,
    proposalId: string,
    ahora: Date = new Date(),
  ): Promise<MaintenanceWindowProposal> {
    const delivery = await this.deliveries.findOneByUserId(userId);
    const previa = await this.propuestaDelChofer(userId, proposalId);
    // Entre que se ofreció y se acepta otro vehículo de la zona pudo ocupar el día.
    if (previa.status === WindowProposalStatus.PENDING) {
      await this.verificarCobertura(
        previa.distributorId,
        previa.task.carId as string,
        previa.windowStart,
        ahora,
      );
    }
    const { caso, propuesta } = await this.responder(
      delivery,
      proposalId,
      ahora,
      async (manager, caso, propuesta) => {
        propuesta.status = WindowProposalStatus.ACCEPTED;
        propuesta.respondedAt = ahora;
        await manager.getRepository(MaintenanceWindowProposal).save(propuesta);
        this.acordar(
          caso,
          propuesta.windowStart,
          propuesta.windowEnd,
          PlanningWindowSource.DRIVER_ACCEPTED,
        );
        await manager.getRepository(MaintenancePlanningCase).save(caso);
        return null;
      },
    );
    this.notifier.alAdminVentanaAcordada(
      caso,
      await this.contextoDelAviso(caso),
      false,
    );
    return propuesta;
  }

  /**
   * El chofer rechaza con motivo. Si propone otra ventana y es viable, queda
   * acordada a la espera del administrador; si no, se le ofrece la siguiente.
   */
  async rechazar(
    userId: string,
    proposalId: string,
    rechazo: RechazoDelChofer,
    ahora: Date = new Date(),
  ): Promise<MaintenanceWindowProposal> {
    const motivo = rechazo.reason.trim();
    if (!motivo) throw new BadRequestException('reason: indicá el motivo');
    const delivery = await this.deliveries.findOneByUserId(userId);
    const params = await this.parametros(delivery.distributorId);
    const alternativa = rechazo.alternative;
    if (alternativa) {
      await this.validarAlternativa(
        delivery,
        proposalId,
        alternativa,
        params,
        ahora,
      );
    }
    const { caso, propuesta, siguiente } = await this.responder(
      delivery,
      proposalId,
      ahora,
      async (manager, caso, propuesta) => {
        propuesta.status = WindowProposalStatus.REJECTED;
        propuesta.respondedAt = ahora;
        propuesta.rejectionReason = motivo;
        propuesta.altWindowStart = alternativa?.start ?? null;
        propuesta.altWindowEnd = alternativa?.end ?? null;
        await manager.getRepository(MaintenanceWindowProposal).save(propuesta);
        if (alternativa) {
          this.acordar(
            caso,
            alternativa.start,
            alternativa.end,
            PlanningWindowSource.DRIVER_ALTERNATIVE,
          );
          await manager.getRepository(MaintenancePlanningCase).save(caso);
          return null;
        }
        return this.ofrecerSiguiente(manager, caso, params, ahora);
      },
    );
    if (caso.status === PlanningCaseStatus.AWAITING_CONFIRMATION) {
      this.notifier.alAdminVentanaAcordada(
        caso,
        await this.contextoDelAviso(caso),
        true,
      );
    } else if (siguiente) {
      await this.notifier.propuestaAlChofer(
        await this.deliveries.findOne(siguiente.deliveryId),
        siguiente,
        await this.contextoDelAviso(caso),
        params.driverEmail === 1,
      );
    } else if (caso.status === PlanningCaseStatus.ESCALATED) {
      await this.avisarEscalado(caso, delivery, ahora);
    }
    return propuesta;
  }

  private acordar(
    caso: MaintenancePlanningCase,
    inicio: Date,
    fin: Date,
    origen: PlanningWindowSource,
  ): void {
    caso.status = PlanningCaseStatus.AWAITING_CONFIRMATION;
    caso.chosenStart = inicio;
    caso.chosenEnd = fin;
    caso.chosenSource = origen;
  }

  /**
   * Lo común de aceptar y rechazar: la propuesta es del chofer, está vigente
   * y su caso sigue negociándose. El caso se bloquea mientras se decide.
   */
  private async responder<T extends MaintenanceWindowProposal | null>(
    delivery: Delivery,
    proposalId: string,
    ahora: Date,
    aplicar: (
      manager: EntityManager,
      caso: MaintenancePlanningCase,
      propuesta: MaintenanceWindowProposal,
    ) => Promise<T>,
  ): Promise<{
    caso: MaintenancePlanningCase;
    propuesta: MaintenanceWindowProposal;
    siguiente: T;
  }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const previa = await manager
          .getRepository(MaintenanceWindowProposal)
          .findOne({
            where: { proposalId, deliveryId: delivery.deliveryId },
          });
        if (!previa) {
          throw new NotFoundException(`Propuesta ${proposalId} no encontrada`);
        }
        const caso = await this.bloquearCaso(manager, previa.caseId);
        const propuesta = await manager
          .getRepository(MaintenanceWindowProposal)
          .findOneOrFail({ where: { proposalId } });
        if (propuesta.status !== WindowProposalStatus.PENDING) {
          throw new ConflictException('La propuesta ya no está vigente');
        }
        if (propuesta.expiresAt.getTime() <= ahora.getTime()) {
          throw new ConflictException('La propuesta venció');
        }
        const siguiente = await aplicar(manager, caso, propuesta);
        return { caso, propuesta, siguiente };
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'propuestas de taller');
    }
  }

  /**
   * La ventana que propone el chofer tiene que caber en un día de taller y
   * respetar lo que respeta el planificador: aviso mínimo, antes del
   * vencimiento y sin dejar la zona bajo el mínimo de unidades.
   */
  private async validarAlternativa(
    delivery: Delivery,
    proposalId: string,
    alt: { start: Date; end: Date },
    params: ValoresDeProceso,
    ahora: Date,
  ): Promise<void> {
    const propuesta = await this.proposals.findOne({
      where: { proposalId, deliveryId: delivery.deliveryId },
      relations: { planningCase: true },
    });
    if (!propuesta) {
      throw new NotFoundException(`Propuesta ${proposalId} no encontrada`);
    }
    const caso = propuesta.planningCase;
    const dia = diaArgentino(alt.start);
    if (alt.end.getTime() <= alt.start.getTime()) {
      throw new BadRequestException(
        'alternative: el fin tiene que ser posterior al inicio',
      );
    }
    if (diaArgentino(new Date(alt.end.getTime() - 1)) !== dia) {
      throw new BadRequestException(
        'alternative: tiene que caber en un mismo día',
      );
    }
    const desde = Math.floor(minutosDelDiaArgentino(alt.start) / 60);
    const hasta = Math.ceil(
      minutosDelDiaArgentino(new Date(alt.end.getTime() - 1)) / 60,
    );
    if (desde < params.workshopStartHour || hasta > params.workshopEndHour) {
      throw new BadRequestException(
        `alternative: tiene que estar dentro del horario de taller (${params.workshopStartHour} a ${params.workshopEndHour} h)`,
      );
    }
    const posibles = enumerarVentanas({
      hoy: ahora,
      proyectado: caso.projectedDueAt,
      minLeadDays: params.minLeadDays,
      horizonDays: params.horizonDays,
      workshopStartHour: params.workshopStartHour,
      workshopEndHour: params.workshopEndHour,
      workshopDays: params.workshopDays,
    });
    if (!posibles.some((v) => v.day === dia)) {
      throw new BadRequestException(
        'alternative: el día tiene que ser posterior al aviso mínimo y anterior al vencimiento proyectado',
      );
    }
    const cars = (await this.carService.findAll(caso.distributorId)).filter(
      (c) => c.fleetStatus === FleetStatus.ACTIVE,
    );
    const ctx = await this.contexto.cargar(
      caso.distributorId,
      cars,
      params,
      ahora,
    );
    const quedan = ctx.unidadesDe(caso.carId)(dia);
    if (quedan !== null && quedan < params.minVehiclesPerZone) {
      throw new BadRequestException(
        'alternative: ese día dejaría la zona de cobertura por debajo del mínimo de unidades',
      );
    }
  }

  // ───────────────────────── lado del administrador ─────────────────────────

  async listarCasos(
    distributorId: string,
    filtro: FiltroDeCasos,
  ): Promise<[CasoCompleto[], number]> {
    const qb = this.cases
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.task', 'task')
      .innerJoinAndSelect('task.plan', 'plan')
      .innerJoinAndSelect('c.car', 'car')
      .leftJoinAndSelect('c.delivery', 'delivery')
      .leftJoinAndSelect('delivery.user', 'deliveryUser')
      .leftJoinAndSelect('c.proposals', 'proposal')
      .withDeleted()
      .where('c.distributor_id = :distributorId', { distributorId });
    if (filtro.status)
      qb.andWhere('c.status = :status', { status: filtro.status });
    if (filtro.carId) qb.andWhere('c.car_id = :carId', { carId: filtro.carId });
    if (filtro.pendientesDelAdmin) {
      qb.andWhere('c.status IN (:...pendientes)', {
        pendientes: [
          PlanningCaseStatus.ESCALATED,
          PlanningCaseStatus.AWAITING_CONFIRMATION,
        ],
      });
    }
    const total = await qb.getCount();
    // `take`/`skip` con joins de una relación a muchos: TypeORM pagina por casos.
    const casos = await qb
      .orderBy('c.openedAt', 'DESC')
      .addOrderBy('c.caseId', 'ASC')
      .take(filtro.limit)
      .skip(filtro.offset)
      .getMany();
    for (const c of casos) {
      c.proposals = [...(c.proposals ?? [])].sort((a, b) => a.rank - b.rank);
    }
    return [casos as CasoCompleto[], total];
  }

  async caso(distributorId: string, caseId: string): Promise<CasoCompleto> {
    const caso = await this.cases.findOne({
      where: { caseId, distributorId },
      relations: {
        task: { plan: true },
        car: true,
        delivery: { user: true },
        proposals: true,
      },
      withDeleted: true,
    });
    if (!caso) throw new NotFoundException(`Caso ${caseId} no encontrado`);
    caso.proposals = [...(caso.proposals ?? [])].sort(
      (a, b) => a.rank - b.rank,
    );
    return caso as CasoCompleto;
  }

  /** Cuántos casos hay en cada estado (el resumen de arriba de la pantalla). */
  async contarPorEstado(
    distributorId: string,
  ): Promise<Record<PlanningCaseStatus, number>> {
    const filas = await this.cases
      .createQueryBuilder('c')
      .select('c.status', 'status')
      .addSelect('COUNT(*)::int', 'n')
      .where('c.distributor_id = :distributorId', { distributorId })
      .groupBy('c.status')
      .getRawMany<{ status: PlanningCaseStatus; n: number }>();
    const conteo = Object.fromEntries(
      Object.values(PlanningCaseStatus).map((s) => [s, 0]),
    ) as Record<PlanningCaseStatus, number>;
    for (const f of filas) conteo[f.status] = f.n;
    return conteo;
  }

  /** Los próximos vencimientos proyectados de la flota, por vehículo. */
  async vencimientos(
    distributorId: string,
    filtro: { carId?: string } = {},
    ahora: Date = new Date(),
  ): Promise<VencimientosDeVehiculo[]> {
    const params = await this.parametros(distributorId);
    const cars = (await this.carService.findAll(distributorId)).filter(
      (c) => !filtro.carId || c.carId === filtro.carId,
    );
    const consumos = await this.forecast.consumos(
      distributorId,
      await this.carService.findAll(distributorId),
      params,
      ahora,
    );
    const abiertas = (await this.tareasAbiertas(distributorId)).filter(
      (t) => !filtro.carId || t.carId === filtro.carId,
    );
    const casosAbiertos = await this.cases.find({
      where: { distributorId, status: In(CASOS_ABIERTOS) },
    });
    const casoPorTarea = new Map(casosAbiertos.map((c) => [c.taskId, c]));

    const resultado: VencimientosDeVehiculo[] = [];
    for (const car of cars) {
      const consumo = consumos.get(car.carId) ?? null;
      const items = abiertas
        .filter((t) => t.carId === car.carId)
        .map((task) => {
          const proyeccion = this.forecast.proyectar(task, car, consumo, ahora);
          return {
            task,
            proyeccion,
            porVencer:
              proyeccion.fecha !== null &&
              proyeccion.fecha.getTime() <=
                ahora.getTime() + task.plan.leadTimeDays * MS_POR_DIA,
            caso: casoPorTarea.get(task.taskId) ?? null,
          };
        })
        .sort(
          (a, b) =>
            (a.proyeccion.fecha?.getTime() ?? Infinity) -
            (b.proyeccion.fecha?.getTime() ?? Infinity),
        );
      if (items.length === 0 && filtro.carId === undefined) continue;
      resultado.push({
        car,
        consumo,
        items,
        proximaVentana: await this.proximaVentana(items, ahora),
      });
    }
    return resultado;
  }

  private async proximaVentana(
    items: VencimientosDeVehiculo['items'],
    ahora: Date,
  ): Promise<VencimientosDeVehiculo['proximaVentana']> {
    const candidatas: NonNullable<VencimientosDeVehiculo['proximaVentana']>[] =
      [];
    for (const { task, caso } of items) {
      if (task.scheduledAt && task.scheduledAt.getTime() > ahora.getTime()) {
        // La ventana confirmada trae su fin; una programada a mano sólo tiene el inicio.
        const confirmado = await this.cases.findOne({
          where: { taskId: task.taskId, status: PlanningCaseStatus.CONFIRMED },
          order: { resolvedAt: 'DESC' },
        });
        const coincide =
          confirmado?.chosenStart?.getTime() === task.scheduledAt.getTime();
        candidatas.push({
          start: task.scheduledAt,
          end:
            coincide && confirmado?.chosenEnd
              ? confirmado.chosenEnd
              : task.scheduledAt,
          estado: PlanningCaseStatus.CONFIRMED,
        });
      }
      if (!caso) continue;
      if (caso.chosenStart && caso.chosenEnd) {
        candidatas.push({
          start: caso.chosenStart,
          end: caso.chosenEnd,
          estado: caso.status,
        });
      } else if (caso.status === PlanningCaseStatus.NEGOTIATING) {
        const pendiente = await this.proposals.findOne({
          where: { caseId: caso.caseId, status: WindowProposalStatus.PENDING },
        });
        if (pendiente) {
          candidatas.push({
            start: pendiente.windowStart,
            end: pendiente.windowEnd,
            estado: caso.status,
          });
        }
      }
    }
    candidatas.sort((a, b) => a.start.getTime() - b.start.getTime());
    return candidatas[0] ?? null;
  }

  /**
   * El administrador resuelve un caso: confirma la ventana acordada con el
   * chofer o elige otra (CU-105, paso 11). La tarea queda programada.
   */
  async confirmar(
    distributorId: string,
    caseId: string,
    resolucion: ResolucionDelAdmin,
    userId: string,
    ahora: Date = new Date(),
  ): Promise<CasoCompleto> {
    const previo = await this.caso(distributorId, caseId);
    const ventana = resolucion.windowStart ?? previo.chosenStart;
    if (ventana && !resolucion.ignoreCoverage && isAbierto(previo.status)) {
      await this.verificarCobertura(
        distributorId,
        previo.carId,
        ventana,
        ahora,
      );
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        const caso = await this.bloquearCaso(manager, caseId, distributorId);
        if (!CASOS_ABIERTOS.includes(caso.status)) {
          throw new ConflictException('El caso ya está resuelto');
        }
        await this.cerrarPendientes(manager, caso);
        await this.programar(manager, caso, resolucion, userId, ahora);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'casos de planificación');
    }
    const caso = await this.caso(distributorId, caseId);
    await this.avisarConfirmacion(caso);
    return caso;
  }

  /**
   * El administrador fija la ventana de una tarea sin esperar al planificador:
   * si hay un caso abierto lo resuelve; si no, lo abre ya resuelto.
   */
  async forzar(
    distributorId: string,
    taskId: string,
    resolucion: ResolucionDelAdmin & { windowStart: Date; windowEnd: Date },
    userId: string,
    ahora: Date = new Date(),
  ): Promise<CasoCompleto> {
    const task = await this.tareaDeVehiculo(distributorId, taskId);
    if (!requiereTaller(task.plan)) {
      throw new BadRequestException(
        'Esta habilitación no se resuelve en un taller: no tiene ventana',
      );
    }
    const abierto = await this.cases.findOne({
      where: { taskId, status: In(CASOS_ABIERTOS) },
    });
    if (abierto) {
      return this.confirmar(
        distributorId,
        abierto.caseId,
        resolucion,
        userId,
        ahora,
      );
    }
    let caseId = '';
    try {
      await this.dataSource.transaction(async (manager) => {
        const deliveryId = await this.assignments.choferDelVehiculoEn(
          task.carId as string,
          distributorId,
          ahora,
        );
        const caso = await manager.getRepository(MaintenancePlanningCase).save(
          manager.getRepository(MaintenancePlanningCase).create({
            distributorId,
            taskId,
            carId: task.carId as string,
            deliveryId,
            status: PlanningCaseStatus.NEGOTIATING,
            projectedDueAt: task.predictedDueAt ?? task.dueAt ?? ahora,
            evaluatedWindows: [],
            openedAt: ahora,
          }),
        );
        caseId = caso.caseId;
        await this.programar(manager, caso, resolucion, userId, ahora);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'casos de planificación');
    }
    const caso = await this.caso(distributorId, caseId);
    await this.avisarConfirmacion(caso);
    return caso;
  }

  /** Descarta el caso abierto de la tarea y vuelve a planificarla ahora. */
  async replanificar(
    distributorId: string,
    taskId: string,
    ahora: Date = new Date(),
  ): Promise<CasoCompleto> {
    const task = await this.tareaDeVehiculo(distributorId, taskId);
    if (!requiereTaller(task.plan)) {
      throw new BadRequestException(
        'Esta habilitación no se resuelve en un taller: no tiene ventana',
      );
    }
    const params = await this.parametros(distributorId);
    const cars = await this.carService.findAll(distributorId);
    const car = cars.find((c) => c.carId === task.carId);
    if (!car) throw new NotFoundException('El vehículo de la tarea no existe');
    const consumos = await this.forecast.consumos(
      distributorId,
      cars,
      params,
      ahora,
    );
    const consumo = consumos.get(car.carId) ?? null;
    const proyeccion = this.forecast.proyectar(task, car, consumo, ahora);
    if (!proyeccion.fecha) {
      throw new BadRequestException(
        'La tarea no tiene fecha de vencimiento ni kilometraje proyectable: no hay qué planificar',
      );
    }
    const ctx = await this.contexto.cargar(
      distributorId,
      cars.filter((c) => c.fleetStatus === FleetStatus.ACTIVE),
      params,
      ahora,
    );
    // Cancelar el caso anterior y abrir el nuevo es todo o nada: una sola transacción.
    const cerradas: MaintenanceWindowProposal[] = [];
    const resultado = await this.planificar(
      { task, consumo, proyeccion },
      car,
      ctx,
      params,
      ahora,
      async (manager) => {
        const abierto = await manager
          .getRepository(MaintenancePlanningCase)
          .findOne({ where: { taskId, status: In(CASOS_ABIERTOS) } });
        if (!abierto) return;
        const caso = await this.bloquearCaso(
          manager,
          abierto.caseId,
          distributorId,
        );
        if (!CASOS_ABIERTOS.includes(caso.status)) return;
        cerradas.push(...(await this.cerrarPendientes(manager, caso)));
        caso.status = PlanningCaseStatus.CANCELLED;
        caso.resolvedAt = ahora;
        caso.notes = 'Re-planificado por el administrador';
        await manager.getRepository(MaintenancePlanningCase).save(caso);
      },
    );
    await this.avisarCierres(cerradas, 'cancelled');
    if (resultado === 'omitido') {
      throw new ConflictException('La tarea ya tiene un caso abierto');
    }
    const caso = await this.cases.findOneOrFail({
      where: { taskId, status: In(CASOS_ABIERTOS) },
    });
    return this.caso(distributorId, caso.caseId);
  }

  /** Cierra un caso abierto sin programar nada (la propuesta vigente se cancela). */
  async cancelar(
    distributorId: string,
    caseId: string,
    motivo: string | undefined,
    ahora: Date = new Date(),
  ): Promise<CasoCompleto> {
    const cerradas: MaintenanceWindowProposal[] = [];
    try {
      await this.dataSource.transaction(async (manager) => {
        const caso = await this.bloquearCaso(manager, caseId, distributorId);
        if (!CASOS_ABIERTOS.includes(caso.status)) {
          throw new ConflictException('El caso ya está resuelto');
        }
        cerradas.push(...(await this.cerrarPendientes(manager, caso)));
        caso.status = PlanningCaseStatus.CANCELLED;
        caso.resolvedAt = ahora;
        caso.notes = motivo ?? null;
        await manager.getRepository(MaintenancePlanningCase).save(caso);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'casos de planificación');
    }
    await this.avisarCierres(cerradas, 'cancelled');
    return this.caso(distributorId, caseId);
  }

  private async tareaDeVehiculo(
    distributorId: string,
    taskId: string,
  ): Promise<MaintenanceTask> {
    const task = await this.tasks.findOne({
      where: { taskId, distributorId },
      relations: { plan: true },
    });
    if (!task) throw new NotFoundException(`Tarea ${taskId} no encontrada`);
    if (!task.carId) {
      throw new BadRequestException(
        'Sólo las tareas de un vehículo tienen ventana de taller',
      );
    }
    if (ESTADOS_CERRADOS.includes(task.status)) {
      throw new ConflictException('La tarea ya está cerrada');
    }
    return task;
  }

  /**
   * Con el caso bloqueado: fija la ventana (la acordada o la que elige el
   * administrador), programa la tarea y cierra el caso.
   */
  private async programar(
    manager: EntityManager,
    caso: MaintenancePlanningCase,
    r: ResolucionDelAdmin,
    userId: string,
    ahora: Date,
  ): Promise<void> {
    let inicio = caso.chosenStart;
    let fin = caso.chosenEnd;
    let origen = caso.chosenSource;
    if (r.windowStart || r.windowEnd) {
      if (!r.windowStart || !r.windowEnd) {
        throw new BadRequestException('windowStart y windowEnd van juntos');
      }
      if (r.windowEnd.getTime() <= r.windowStart.getTime()) {
        throw new BadRequestException(
          'windowEnd: tiene que ser posterior a windowStart',
        );
      }
      if (r.windowStart.getTime() < ahora.getTime() - 5 * 60_000) {
        throw new BadRequestException(
          'windowStart: la ventana tiene que ser a futuro',
        );
      }
      inicio = r.windowStart;
      fin = r.windowEnd;
      origen = PlanningWindowSource.ADMIN;
    }
    if (!r.windowStart && inicio && inicio.getTime() < ahora.getTime()) {
      throw new BadRequestException(
        'La ventana acordada ya pasó: elegí otra (windowStart y windowEnd)',
      );
    }
    if (!inicio || !fin || !origen) {
      throw new BadRequestException(
        'Indicá la ventana (windowStart y windowEnd): el caso todavía no tiene una acordada con el chofer',
      );
    }
    const tareaRepo = manager.getRepository(MaintenanceTask);
    const task = await tareaRepo.findOneOrFail({
      where: { taskId: caso.taskId },
    });
    if (ESTADOS_CERRADOS.includes(task.status)) {
      throw new ConflictException('La tarea ya está cerrada');
    }
    task.status = MaintenanceTaskStatus.SCHEDULED;
    task.scheduledAt = inicio;
    if (r.provider !== undefined) task.provider = r.provider;
    if (r.cost !== undefined) task.cost = r.cost;
    if (r.notes)
      task.notes = task.notes ? `${task.notes}\n\n${r.notes}` : r.notes;
    await tareaRepo.save(task);

    caso.status = PlanningCaseStatus.CONFIRMED;
    caso.chosenStart = inicio;
    caso.chosenEnd = fin;
    caso.chosenSource = origen;
    caso.resolvedAt = ahora;
    caso.resolvedByUserId = userId;
    await manager.getRepository(MaintenancePlanningCase).save(caso);
  }

  /** Cancela la propuesta que seguía esperando respuesta del chofer. */
  private async cerrarPendientes(
    manager: EntityManager,
    caso: MaintenancePlanningCase,
  ): Promise<MaintenanceWindowProposal[]> {
    const repo = manager.getRepository(MaintenanceWindowProposal);
    const pendientes = await repo.find({
      where: { caseId: caso.caseId, status: WindowProposalStatus.PENDING },
    });
    for (const p of pendientes) {
      p.status = WindowProposalStatus.CANCELLED;
    }
    return pendientes.length > 0 ? repo.save(pendientes) : [];
  }

  private async avisarCierres(
    cerradas: readonly MaintenanceWindowProposal[],
    motivo: 'cancelled' | 'resolved',
  ): Promise<void> {
    for (const p of cerradas) {
      try {
        const delivery = await this.deliveries.findOne(p.deliveryId);
        this.notifier.propuestaCerrada(delivery.userId, p.proposalId, motivo);
      } catch (error) {
        this.logger.warn(`No se pudo avisar el cierre: ${errorMessage(error)}`);
      }
    }
  }

  private async avisarConfirmacion(caso: CasoCompleto): Promise<void> {
    await this.avisarCierres(
      caso.proposals.filter((p) => p.status === WindowProposalStatus.CANCELLED),
      'resolved',
    );
    if (!caso.deliveryId) return;
    try {
      const delivery = await this.deliveries.findOne(caso.deliveryId);
      await this.notifier.ventanaConfirmada(delivery, caso, {
        planName: caso.task.plan.name,
        patent: caso.car.carPatent ?? '-',
      });
    } catch (error) {
      this.logger.warn(`No se pudo avisar al chofer: ${errorMessage(error)}`);
    }
  }

  private async bloquearCaso(
    manager: EntityManager,
    caseId: string,
    distributorId?: string,
  ): Promise<MaintenancePlanningCase> {
    const caso = await manager.getRepository(MaintenancePlanningCase).findOne({
      where: distributorId ? { caseId, distributorId } : { caseId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!caso) throw new NotFoundException(`Caso ${caseId} no encontrado`);
    return caso;
  }

  /** Distribuidoras con tareas de vehículo abiertas: las que el cron recorre. */
  async distribuidorasConTareas(): Promise<string[]> {
    const filas = await this.tasks
      .createQueryBuilder('t')
      .select('DISTINCT t.distributor_id', 'id')
      .where('t.car_id IS NOT NULL')
      .andWhere('t.status NOT IN (:...cerrados)', {
        cerrados: ESTADOS_CERRADOS,
      })
      .getRawMany<{ id: string }>();
    return filas.map((f) => f.id);
  }
}
