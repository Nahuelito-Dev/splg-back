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
import { escaparHtml } from '../common/utils/html.util';
import {
  minutosDelDiaArgentino,
  ZONA_ARGENTINA,
} from '../common/utils/dias-argentina';
import { ScheduledTasksSettingsService } from '../distributor/scheduled-tasks-settings.service';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeDocumentsService } from './employee-documents.service';
import { EmployeeConPuesto } from '../employee/employee.mapper';
import { MaintenancePlan } from './entities/maintenance-plan.entity';

/** Un chofer activo al que le falta cargar documentación bloqueante (CU-188). */
interface FaltanteDeChofer {
  empleado: EmployeeConPuesto;
  planes: MaintenancePlan[];
}

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * CU-142 y CU-188: aviso automático de vencimientos de la flota y del
 * personal. Una vez por día, junta las tareas abiertas (de un vehículo, un
 * chofer o un empleado) que entraron en "por vencer" o "vencido" y todavía no
 * se avisaron (`alertedAt IS NULL`), les manda un mail a los admins de cada
 * distribuidora con `EmailSenderPort` (reusando el mecanismo de envío que ya
 * existe, sin agregar otro), y marca `alertedAt` — una sola vez por tarea, no
 * se re-notifica todos los días.
 *
 * El mismo correo lista los documentos bloqueantes que les faltan a los
 * choferes activos: esos NO se marcan como avisados, se repiten cada día hasta
 * que se carguen.
 *
 * El tic es de una hora y cada distribuidora recibe el aviso a la hora que
 * configuró (CU-173, `fleetAlertHour`; por omisión las 8).
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
    private readonly frecuencias: ScheduledTasksSettingsService,
    private readonly employees: EmployeeService,
    private readonly documents: EmployeeDocumentsService,
  ) {}

  @Cron('0 * * * *', { timeZone: ZONA_ARGENTINA }) // cada hora en punto; cada distribuidora avisa a su hora (Argentina)
  async avisarVencimientosPendientes(): Promise<void> {
    const candidatas = await this.tareasSinAvisar();
    const porDistribuidora = this.agruparPorDistribuidora(candidatas);
    const conChoferes = await this.employees.distribuidorasConChoferesActivos();
    const distribuidoras = new Set([
      ...porDistribuidora.keys(),
      ...conChoferes,
    ]);
    if (distribuidoras.size === 0) return;

    const horaActual = Math.floor(minutosDelDiaArgentino() / 60);

    for (const distributorId of distribuidoras) {
      if (
        !(await this.frecuencias.esLaHoraDelAvisoDeFlota(
          distributorId,
          horaActual,
        ))
      ) {
        continue;
      }
      await this.avisarDistribuidora(
        distributorId,
        porDistribuidora.get(distributorId) ?? [],
      );
    }
  }

  private async tareasSinAvisar(): Promise<MaintenanceTask[]> {
    const abiertas = await this.tasks
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoinAndSelect('task.car', 'car')
      .leftJoinAndSelect('task.delivery', 'delivery')
      .leftJoinAndSelect('delivery.user', 'deliveryUser')
      .leftJoinAndSelect('task.employee', 'employee')
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
      const faltantes: FaltanteDeChofer[] =
        await this.documents.faltantesBloqueantesDeChoferes(distributorId);
      if (tareas.length === 0 && faltantes.length === 0) return;

      const admins = await this.adminService.findAll(distributorId);
      const destinatarios = admins
        .map((a) => a.user?.email)
        .filter((email): email is string => Boolean(email));

      if (destinatarios.length > 0) {
        const html = this.armarHtml(tareas, faltantes);
        await Promise.all(
          destinatarios.map((to) =>
            this.emailSender.send({
              to,
              subject: this.asunto(tareas, faltantes),
              html,
            }),
          ),
        );
      }

      if (tareas.length > 0) {
        const ahora = new Date();
        await this.tasks.update(
          tareas.map((t) => t.taskId),
          { alertedAt: ahora },
        );
      }
    } catch (error) {
      // No se marca alertedAt: se reintenta la próxima corrida.
      this.logger.error(
        `No se pudo avisar los vencimientos de la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }

  private asunto(
    tareas: MaintenanceTask[],
    faltantes: FaltanteDeChofer[],
  ): string {
    const partes: string[] = [];
    if (tareas.length > 0) partes.push(`${tareas.length} pendiente(s)`);
    if (faltantes.length > 0) {
      partes.push(`${faltantes.length} chofer(es) con documentos sin cargar`);
    }
    return `Vencimientos de flota y personal: ${partes.join(', ')}`;
  }

  private armarHtml(
    tareas: MaintenanceTask[],
    faltantes: FaltanteDeChofer[],
  ): string {
    const filas = tareas
      .map((t) => {
        const fecha = t.dueAt ? t.dueAt.toLocaleDateString('es-AR') : '-';
        return `<li>${escaparHtml(t.plan.name)} — ${escaparHtml(this.sujeto(t))} — vence ${fecha}</li>`;
      })
      .join('');
    const vencimientos =
      tareas.length > 0
        ? `<p>Estos vencimientos necesitan atención:</p><ul>${filas}</ul>`
        : '';
    const sinCargar = faltantes
      .map(
        ({ empleado, planes }) =>
          `<li>${escaparHtml(`${empleado.firstName} ${empleado.lastName}`)} — falta: ${escaparHtml(planes.map((p) => p.name).join(', '))}</li>`,
      )
      .join('');
    const faltan =
      faltantes.length > 0
        ? `<p>Estos choferes no tienen cargada documentación que bloquea el despacho:</p><ul>${sinCargar}</ul>`
        : '';
    return `${vencimientos}${faltan}`;
  }

  private sujeto(t: MaintenanceTask): string {
    if (t.car) return `Vehículo ${t.car.carPatent ?? t.carId}`;
    if (t.employee)
      return `Empleado ${t.employee.firstName} ${t.employee.lastName}`;
    return `Chofer ${t.delivery?.user?.fullName ?? t.deliveryId}`;
  }
}
