import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import {
  calcularEstadoDeVencimiento,
  ExpirationStatus,
} from './domain/expiration-status';
import { errorMessage } from '../common/errors/error-message';

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * CU-142: aviso automático de vencimientos. Una vez por día, junta las
 * tareas abiertas que entraron en "por vencer" o "vencido" y todavía no se
 * avisaron (`alertedAt IS NULL`), les manda un mail a los admins de cada
 * distribuidora con `EmailSenderPort` (reusando el mecanismo de envío que ya
 * existe, sin agregar otro), y marca `alertedAt` — una sola vez por tarea, no
 * se re-notifica todos los días.
 *
 * Si el envío falla, NO marca `alertedAt`: se reintenta al día siguiente.
 * Si no hay ningún admin con email en la distribuidora, se marca igual (no
 * hay a quién avisarle una segunda vez).
 */
@Injectable()
export class FleetAlertsCron {
  private readonly logger = new Logger(FleetAlertsCron.name);

  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    private readonly adminService: AdminService,
    private readonly emailSender: EmailSenderPort,
  ) {}

  @Cron('0 8 * * *') // todos los días a las 8 AM (hora del servidor)
  async avisarVencimientosPendientes(): Promise<void> {
    const candidatas = await this.tareasSinAvisar();
    if (candidatas.length === 0) return;

    const porDistribuidora = this.agruparPorDistribuidora(candidatas);

    for (const [distributorId, tareas] of porDistribuidora) {
      await this.avisarDistribuidora(distributorId, tareas);
    }
  }

  private async tareasSinAvisar(): Promise<MaintenanceTask[]> {
    const abiertas = await this.tasks
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoinAndSelect('task.car', 'car')
      .leftJoinAndSelect('task.delivery', 'delivery')
      .leftJoinAndSelect('delivery.user', 'deliveryUser')
      .where('task.status NOT IN (:...cerrados)', {
        cerrados: ESTADOS_CERRADOS,
      })
      .andWhere('task.due_at IS NOT NULL')
      .andWhere('task.alerted_at IS NULL')
      .getMany();

    // El "por vencer" depende del lead_time_days de CADA plan: no es un
    // filtro que se pueda expresar como una sola condición SQL simple, así
    // que se calcula acá con la misma función que usa el resto del módulo.
    return abiertas.filter((task) => {
      const estado = calcularEstadoDeVencimiento(
        task.dueAt,
        task.plan.leadTimeDays,
      );
      return (
        estado === ExpirationStatus.DUE_SOON ||
        estado === ExpirationStatus.EXPIRED
      );
    });
  }

  private agruparPorDistribuidora(
    tareas: MaintenanceTask[],
  ): Map<string, MaintenanceTask[]> {
    const mapa = new Map<string, MaintenanceTask[]>();
    for (const tarea of tareas) {
      const lista = mapa.get(tarea.distributorId) ?? [];
      lista.push(tarea);
      mapa.set(tarea.distributorId, lista);
    }
    return mapa;
  }

  private async avisarDistribuidora(
    distributorId: string,
    tareas: MaintenanceTask[],
  ): Promise<void> {
    try {
      const admins = await this.adminService.findAll(distributorId);
      const destinatarios = admins
        .map((a) => a.user?.email)
        .filter((email): email is string => Boolean(email));

      if (destinatarios.length > 0) {
        const html = this.armarHtml(tareas);
        await Promise.all(
          destinatarios.map((to) =>
            this.emailSender.send({
              to,
              subject: `Vencimientos de flota: ${tareas.length} pendiente(s)`,
              html,
            }),
          ),
        );
      }

      const ahora = new Date();
      await this.tasks.update(
        tareas.map((t) => t.taskId),
        { alertedAt: ahora },
      );
    } catch (error) {
      // No se marca alertedAt: se reintenta la próxima corrida.
      this.logger.error(
        `No se pudo avisar los vencimientos de la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }

  private armarHtml(tareas: MaintenanceTask[]): string {
    const filas = tareas
      .map((t) => {
        const sujeto = t.car
          ? `Vehículo ${t.car.carPatent ?? t.carId}`
          : `Chofer ${t.delivery?.user?.fullName ?? t.deliveryId}`;
        const fecha = t.dueAt ? t.dueAt.toLocaleDateString('es-AR') : '-';
        return `<li>${t.plan.name} — ${sujeto} — vence ${fecha}</li>`;
      })
      .join('');
    return `<p>Estos vencimientos de flota necesitan atención:</p><ul>${filas}</ul>`;
  }
}
