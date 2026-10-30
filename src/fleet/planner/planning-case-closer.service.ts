import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  EVENTO_VEHICULO_DADO_DE_BAJA,
  VehiculoDadoDeBajaEvent,
} from '../../car/events/vehiculo-dado-de-baja.event';
import { errorMessage } from '../../common/errors/error-message';
import { DeliveryService } from '../../delivery/delivery.service';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import { MaintenancePlannerNotifier } from './maintenance-planner-notifier';

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
