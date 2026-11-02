import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  EVENTO_VEHICULO_DADO_DE_BAJA,
  VehiculoDadoDeBajaEvent,
} from '../../car/events/vehiculo-dado-de-baja.event';
import { errorMessage } from '../../common/errors/error-message';
import {
  inicioDelDiaArgentino,
  minutosDelDiaArgentino,
} from '../../common/utils/dias-argentina';
import { DeliveryService } from '../../delivery/delivery.service';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
  PlanningWindowSource,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import { MaintenancePlannerNotifier } from './maintenance-planner-notifier';

/** Margen para el reloj del cliente: una ventana puede arrancar hasta 5 minutos atrás. */
const MARGEN_A_FUTURO_MS = 5 * 60_000;

const CASOS_ABIERTOS = [
  PlanningCaseStatus.NEGOTIATING,
  PlanningCaseStatus.AWAITING_CONFIRMATION,
  PlanningCaseStatus.ESCALATED,
];

/**
 * Cierra los casos de planificación que quedaron sin objeto: la tarea se
 * cerró o se canceló por fuera del planificador, o el vehículo se dio de baja.
 * El caso se cancela con su motivo, la propuesta que esperaba al chofer se
 * cancela y a él se le avisa para que la app la saque de la lista.
 */
@Injectable()
export class PlanningCaseCloser {
  private readonly logger = new Logger(PlanningCaseCloser.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deliveries: DeliveryService,
    private readonly notifier: MaintenancePlannerNotifier,
  ) {}

  /**
   * Cancela los casos abiertos que cumplan `donde`, dentro de la transacción de
   * quien llama. Devuelve las propuestas que esperaban respuesta, para avisar
   * al chofer una vez confirmada la transacción (`avisar`).
   */
  async cerrar(
    manager: EntityManager,
    donde: { taskId: string } | { carId: string },
    motivo: string,
    ahora: Date = new Date(),
  ): Promise<MaintenanceWindowProposal[]> {
    const casos = await manager
      .getRepository(MaintenancePlanningCase)
      .find({ where: { ...donde, status: In(CASOS_ABIERTOS) } });
    const cerradas: MaintenanceWindowProposal[] = [];
    for (const caso of casos) {
      const repo = manager.getRepository(MaintenanceWindowProposal);
      const pendientes = await repo.find({
        where: { caseId: caso.caseId, status: WindowProposalStatus.PENDING },
      });
      for (const p of pendientes) p.status = WindowProposalStatus.CANCELLED;
      if (pendientes.length > 0)
        cerradas.push(...(await repo.save(pendientes)));
      caso.status = PlanningCaseStatus.CANCELLED;
      caso.resolvedAt = ahora;
      caso.notes = motivo;
      await manager.getRepository(MaintenancePlanningCase).save(caso);
    }
    return cerradas;
  }

  /**
   * El administrador cambió el turno agendado de la tarea: la ventana del caso
   * confirmado (vigente o futura) lo sigue, en la misma transacción y con el
   * caso bloqueado. `{ dia }` (sólo fecha) mueve la ventana a ese día argentino
   * conservando su hora de inicio; `{ inicio }` la arranca a esa hora; `null`
   * cancela el caso. En todos los casos de movimiento la duración se conserva.
   * Las ventanas que ya terminaron no se tocan. Devuelve el inicio nuevo de la
   * ventana (`undefined` si no había caso que mover o si se canceló).
   */
  async reprogramarConfirmado(
    manager: EntityManager,
    taskId: string,
    destino: { dia: string } | { inicio: Date } | null,
    userId: string | null = null,
    ahora: Date = new Date(),
  ): Promise<Date | undefined> {
    const repo = manager.getRepository(MaintenancePlanningCase);
    const casos = await repo.find({
      where: { taskId, status: PlanningCaseStatus.CONFIRMED },
      lock: { mode: 'pessimistic_write' },
    });
    let nuevoInicio: Date | undefined;
    for (const caso of casos) {
      if (!caso.chosenStart || !caso.chosenEnd) continue;
      if (caso.chosenEnd.getTime() <= ahora.getTime()) continue;
      if (destino === null) {
        caso.status = PlanningCaseStatus.CANCELLED;
        caso.resolvedAt = ahora;
        caso.resolvedByUserId = userId;
        caso.notes =
          'El administrador canceló el turno agendado de la tarea: la ventana confirmada se canceló';
      } else {
        const inicio = this.inicioNuevo(destino, caso.chosenStart);
        if (inicio.getTime() < ahora.getTime() - MARGEN_A_FUTURO_MS) {
          throw new BadRequestException(
            'scheduledAt: la ventana tiene que ser a futuro',
          );
        }
        const duracion = caso.chosenEnd.getTime() - caso.chosenStart.getTime();
        caso.chosenStart = inicio;
        caso.chosenEnd = new Date(inicio.getTime() + duracion);
        caso.chosenSource = PlanningWindowSource.ADMIN;
        caso.resolvedByUserId = userId;
        caso.notes =
          'El administrador reprogramó el turno agendado de la tarea: la ventana confirmada se movió';
        nuevoInicio = inicio;
      }
      await repo.save(caso);
    }
    return nuevoInicio;
  }

  private inicioNuevo(
    destino: { dia: string } | { inicio: Date },
    actual: Date,
  ): Date {
    if ('inicio' in destino) return destino.inicio;
    const inicioDelDia = inicioDelDiaArgentino(destino.dia);
    if (!inicioDelDia) {
      throw new BadRequestException(
        `scheduledAt: día inválido (${destino.dia})`,
      );
    }
    return new Date(
      inicioDelDia.getTime() + minutosDelDiaArgentino(actual) * 60_000,
    );
  }

  /** Avisa a cada chofer que su propuesta se cerró. Best-effort. */
  async avisar(cerradas: readonly MaintenanceWindowProposal[]): Promise<void> {
    for (const p of cerradas) {
      try {
        const delivery = await this.deliveries.findOne(p.deliveryId);
        this.notifier.propuestaCerrada(
          delivery.userId,
          p.proposalId,
          'cancelled',
        );
      } catch (error) {
        this.logger.warn(`No se pudo avisar el cierre: ${errorMessage(error)}`);
      }
    }
  }

  @OnEvent(EVENTO_VEHICULO_DADO_DE_BAJA)
  async alDarDeBajaElVehiculo(evento: VehiculoDadoDeBajaEvent): Promise<void> {
    try {
      const cerradas = await this.dataSource.transaction((manager) =>
        this.cerrar(
          manager,
          { carId: evento.carId },
          'El vehículo se dio de baja',
        ),
      );
      await this.avisar(cerradas);
    } catch (error) {
      this.logger.error(
        `No se pudieron cerrar los casos del vehículo ${evento.carId}: ${errorMessage(error)}`,
      );
    }
  }
}
