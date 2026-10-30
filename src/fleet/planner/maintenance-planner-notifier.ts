import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EmailSenderPort } from '../../email/ports/email-sender.port';
import { FcmPort } from '../../firebase/ports/fcm.port';
import { DriversGateway } from '../../gateways/drivers.gateway';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { errorMessage } from '../../common/errors/error-message';
import { escaparHtml } from '../../common/utils/html.util';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { Delivery } from '../../delivery/entities/delivery.entity';
import {
  MaintenancePlanningCase,
  PlanningEscalationReason,
} from '../entities/maintenance-planning-case.entity';
import { MaintenanceWindowProposal } from '../entities/maintenance-window-proposal.entity';

/** A qué tarea y vehículo se refiere un aviso (los textos se arman con esto). */
export interface ContextoDelAviso {
  planName: string;
  patent: string;
}

const MOTIVO_DE_ESCALAMIENTO: Readonly<
  Record<PlanningEscalationReason, string>
> = {
  [PlanningEscalationReason.NO_DRIVER]:
    'el vehículo no tiene chofer asignado con quien negociar la ventana',
  [PlanningEscalationReason.COVERAGE]:
    'toda ventana posible deja la zona de cobertura por debajo del mínimo de unidades',
  [PlanningEscalationReason.EXHAUSTED]:
    'el chofer rechazó o no respondió ninguna de las ventanas ofrecidas',
  [PlanningEscalationReason.NO_WINDOWS]:
    'no hay días disponibles antes del vencimiento proyectado',
};

export function textoDeEscalamiento(motivo: PlanningEscalationReason): string {
  return MOTIVO_DE_ESCALAMIENTO[motivo];
}

function cuando(fecha: Date): string {
  return fecha.toLocaleString('es-AR', {
    timeZone: ZONA_ARGENTINA,
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

/**
 * Los avisos de la planificación de flota (CU-105): al chofer por socket, push
 * y correo, y al administrador por la bandeja. Todo es best-effort: el hecho
 * que se avisa ya ocurrió, así que una entrega que falla se registra y no
 * deshace la propuesta.
 */
@Injectable()
export class MaintenancePlannerNotifier {
  private readonly logger = new Logger(MaintenancePlannerNotifier.name);

  constructor(
    private readonly drivers: DriversGateway,
    private readonly fcm: FcmPort,
    private readonly emailSender: EmailSenderPort,
    private readonly events: EventEmitter2,
  ) {}

  /** Propuesta nueva: socket, push y correo al chofer. */
  async propuestaAlChofer(
    delivery: Delivery,
    proposal: MaintenanceWindowProposal,
    ctx: ContextoDelAviso,
    conCorreo: boolean,
  ): Promise<void> {
    const payload = {
      proposalId: proposal.proposalId,
      taskId: proposal.taskId,
      windowStart: proposal.windowStart.toISOString(),
      windowEnd: proposal.windowEnd.toISOString(),
      expiresAt: proposal.expiresAt.toISOString(),
      taskName: ctx.planName,
      patent: ctx.patent,
    };
    const titulo = `Turno de taller para ${ctx.patent}`;
    const detalle = `${ctx.planName}: ${cuando(proposal.windowStart)}`;
    await this.seguro('socket', () =>
      this.drivers.notifyMaintenance(
        delivery.userId,
        'maintenance:proposal',
        payload,
      ),
    );
    if (delivery.notificationToken) {
      const token = delivery.notificationToken;
      await this.seguro('push', () =>
        this.fcm.sendToToken(token, {
          notification: { title: titulo, body: detalle },
          data: {
            type: 'MAINTENANCE_PROPOSAL',
            proposalId: proposal.proposalId,
          },
        }),
      );
    }
    // El correo al chofer es opcional por distribuidora (`driverEmail`): nunca por omisión.
    const email = conCorreo ? delivery.user?.email : undefined;
    if (email) {
      await this.seguro('correo', () =>
        this.emailSender.send({
          to: email,
          subject: titulo,
          html: `<p>${escaparHtml(detalle)}.</p><p>Respondé desde la app del chofer antes de ${escaparHtml(cuando(proposal.expiresAt))}; si no podés, rechazala o proponé otro horario.</p>`,
        }),
      );
    }
  }

  /** La propuesta ya no corre (venció, se re-planificó o la resolvió el admin): la app la saca de la lista. */
  propuestaCerrada(
    userId: string,
    proposalId: string,
    motivo: 'expired' | 'cancelled' | 'resolved',
  ): void {
    void this.seguro('socket', () =>
      this.drivers.notifyMaintenance(userId, 'maintenance:proposal-closed', {
        proposalId,
        reason: motivo,
      }),
    );
  }

  /** El administrador confirmó el taller: el turno quedó programado. */
  async ventanaConfirmada(
    delivery: Delivery,
    caso: MaintenancePlanningCase,
    ctx: ContextoDelAviso,
  ): Promise<void> {
    if (!caso.chosenStart) return;
    await this.seguro('socket', () =>
      this.drivers.notifyMaintenance(
        delivery.userId,
        'maintenance:window-confirmed',
        {
          caseId: caso.caseId,
          taskId: caso.taskId,
          windowStart: caso.chosenStart?.toISOString(),
          windowEnd: caso.chosenEnd?.toISOString(),
          source: caso.chosenSource,
          taskName: ctx.planName,
          patent: ctx.patent,
        },
      ),
    );
    if (delivery.notificationToken) {
      const token = delivery.notificationToken;
      await this.seguro('push', () =>
        this.fcm.sendToToken(token, {
          notification: {
            title: `Taller confirmado para ${ctx.patent}`,
            body: `${ctx.planName}: ${cuando(caso.chosenStart as Date)}`,
          },
          data: { type: 'MAINTENANCE_CONFIRMED', caseId: caso.caseId },
        }),
      );
    }
  }

  /** El caso pasó al administrador: la app del chofer lo saca de la lista de pendientes. */
  escaladoAlChofer(
    delivery: Delivery,
    caso: MaintenancePlanningCase,
    ctx: ContextoDelAviso,
  ): void {
    void this.seguro('socket', () =>
      this.drivers.notifyMaintenance(
        delivery.userId,
        'maintenance:case-escalated',
        {
          caseId: caso.caseId,
          taskId: caso.taskId,
          reason: caso.escalationReason,
          taskName: ctx.planName,
          patent: ctx.patent,
        },
      ),
    );
  }

  /**
   * Un caso acordado con el chofer sigue esperando al administrador: una vez
   * por día, sin correo. Si la ventana acordada ya pasó lo dice, porque ya no
   * se puede confirmar y hay que elegir otra.
   */
  alAdminAcordadoPendiente(
    caso: MaintenancePlanningCase,
    ctx: ContextoDelAviso,
    dia: string,
  ): void {
    if (!caso.chosenStart) return;
    const vencida = caso.chosenStart.getTime() < Date.now();
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: caso.distributorId,
      kind: 'maintenance_window_agreed',
      title: `Taller a confirmar: ${ctx.planName}`,
      body: vencida
        ? `${ctx.patent} — la ventana acordada (${cuando(caso.chosenStart)}) ya pasó: elegí otra y confirmá el taller.`
        : `${ctx.patent} — sigue sin confirmarse el taller acordado para ${cuando(caso.chosenStart)}.`,
      link: { entity: 'maintenance-planner', id: caso.caseId },
      dedupeKey: `maintenance-case:${caso.caseId}:agreed-reminder:${dia}`,
    });
  }

  /** El chofer aceptó (o propuso otra ventana): falta que el administrador confirme el taller y el gasto. */
  alAdminVentanaAcordada(
    caso: MaintenancePlanningCase,
    ctx: ContextoDelAviso,
    propuestaDelChofer: boolean,
  ): void {
    if (!caso.chosenStart) return;
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: caso.distributorId,
      kind: 'maintenance_window_agreed',
      title: `Taller a confirmar: ${ctx.planName}`,
      body: `${ctx.patent} — el chofer ${propuestaDelChofer ? 'propone' : 'aceptó'}: ${cuando(caso.chosenStart)}; falta que confirmes el taller y el gasto.`,
      link: { entity: 'maintenance-planner', id: caso.caseId },
      dedupeKey: `maintenance-case:${caso.caseId}:agreed:${caso.chosenStart.toISOString()}`,
    });
  }

  /**
   * El caso queda en manos del administrador. `repetido` es la reiteración de
   * cada corrida (CU-105, paso 11): sin correo y con una clave por día.
   */
  alAdminEscalado(
    caso: MaintenancePlanningCase,
    ctx: ContextoDelAviso,
    dia: string,
    repetido: boolean,
  ): void {
    const motivo = caso.escalationReason
      ? textoDeEscalamiento(caso.escalationReason)
      : 'sin ventana acordada';
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: caso.distributorId,
      kind: 'maintenance_escalated',
      title: `Resolvé el taller: ${ctx.planName}`,
      body: `${ctx.patent} — ${motivo}. Elegí una ventana y confirmá el taller.`,
      link: { entity: 'maintenance-planner', id: caso.caseId },
      email: !repetido,
      dedupeKey: repetido
        ? `maintenance-case:${caso.caseId}:escalated:${dia}`
        : `maintenance-case:${caso.caseId}:escalated`,
    });
  }

  alAdminVehiculoFueraDeServicio(
    distributorId: string,
    carId: string,
    ctx: ContextoDelAviso,
    dia: string,
  ): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId,
      kind: 'vehicle_grounded_expired',
      title: `Fuera de servicio: ${ctx.patent}`,
      body: `${ctx.planName} venció sin ventana de taller acordada: el vehículo dejó de recibir pedidos.`,
      link: { entity: 'car', id: carId },
      dedupeKey: `vehicle-grounded:${carId}:${ctx.planName}:${dia}`,
    });
  }

  private async seguro(que: string, f: () => unknown): Promise<void> {
    try {
      await f();
    } catch (error) {
      this.logger.warn(`No se pudo avisar (${que}): ${errorMessage(error)}`);
    }
  }
}
