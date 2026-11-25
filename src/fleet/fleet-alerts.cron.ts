import { EventEmitter2 } from '@nestjs/event-emitter';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { FleetTaskBoardNotifier } from './fleet-task-board.notifier';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { armarCorreo } from '../email/layout/correo';
import {
  marcaDeDistribuidora,
  nombreDeDistribuidoraDeAdmins,
} from '../email/layout/marca-de-correo';
import { mensajeDeVencimientos } from './correo-vencimientos';
import {
  calcularEstadoDeVencimiento,
  ExpirationStatus,
} from './domain/expiration-status';
import { errorMessage } from '../common/errors/error-message';
import {
  minutosDelDiaArgentino,
  ZONA_ARGENTINA,
} from '../common/utils/dias-argentina';
import { ScheduledTasksSettingsService } from '../distributor/scheduled-tasks-settings.service';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeDocumentsService } from './employee-documents.service';
import { EmployeeConPuesto } from '../employee/employee.mapper';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { ConRegistro } from '../process-run/process-run.recorder';
import { ProcessName } from '../process-run/domain/process-catalog';

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
    private readonly events: EventEmitter2,
    // El tablero del panel (`fleet:task`): las vencidas se marcan `isOverdue`.
    @Optional() private readonly tablero?: FleetTaskBoardNotifier,
  ) {}

  @Cron('0 * * * *', { timeZone: ZONA_ARGENTINA }) // cada hora en punto; cada distribuidora avisa a su hora (Argentina)
  @ConRegistro(ProcessName.FLEET_ALERTS)
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

  /**
   * Las tareas abiertas que están por vencer o vencidas. Las que todavía no se
   * avisaron por mail (`alertedAt` nulo) van al correo; todas van a la bandeja
   * (que no repite: una vez «por vencer» y otra «vencido»).
   */
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
    vencimientos: MaintenanceTask[],
  ): Promise<void> {
    try {
      const faltantes: FaltanteDeChofer[] =
        await this.documents.faltantesBloqueantesDeChoferes(distributorId);
      this.avisarEnLaBandeja(distributorId, vencimientos, faltantes);
      await this.tablero?.avisarVarias(
        distributorId,
        vencimientos
          .filter(
            (t) =>
              calcularEstadoDeVencimiento(t.dueAt, t.plan.leadTimeDays) ===
              ExpirationStatus.EXPIRED,
          )
          .map((t) => t.taskId),
        'overdue',
      );

      // Al correo, sólo lo que todavía no se avisó por mail.
      const tareas = vencimientos.filter((t) => t.alertedAt === null);
      if (tareas.length === 0 && faltantes.length === 0) return;

      const admins = await this.adminService.findAll(distributorId);
      const destinatarios = admins
        .map((a) => a.user?.email)
        .filter((email): email is string => Boolean(email));

      if (destinatarios.length > 0) {
        const correo = armarCorreo(
          marcaDeDistribuidora(nombreDeDistribuidoraDeAdmins(admins)),
          this.mensaje(tareas, faltantes),
        );
        await Promise.all(
          destinatarios.map((to) =>
            this.emailSender.send({
              to,
              subject: correo.asunto,
              html: correo.html,
              text: correo.text,
              registro: { type: 'FLEET_ALERT', distributorId },
            }),
          ),
        );
      }

      if (tareas.length > 0) {
        // `update` y no `save`: sólo escribe la marca. Con `save`, la tarea que
        // el admin cerró o editó mientras salía el mail volvería a los valores
        // leídos al principio. (`alertedAt` está fuera de la auditoría de datos
        // a propósito: es una marca técnica del aviso.)
        const ahora = new Date();
        // `updated_at` queda como estaba: la marca del aviso no es un cambio de la
        // tarea y no tiene que invalidar la precondición del tablero (`If-Match`).
        await this.tasks.update(
          tareas.map((t) => t.taskId),
          { alertedAt: ahora, updatedAt: () => '"updated_at"' },
        );
      }
    } catch (error) {
      // No se marca alertedAt: se reintenta la próxima corrida.
      this.logger.error(
        `No se pudo avisar los vencimientos de la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Un aviso por vencimiento y por documento faltante en la bandeja del admin
   * (F11). La bandeja no repite la misma clave: «por vencer» y «vencido» son
   * dos avisos por fecha de vencimiento; un documento faltante, uno por mes. El correo es el resumen de
   * arriba: acá no se pide mail para no mandarlo dos veces.
   */
  private avisarEnLaBandeja(
    distributorId: string,
    vencimientos: MaintenanceTask[],
    faltantes: FaltanteDeChofer[],
  ): void {
    for (const tarea of vencimientos) {
      const vencida =
        calcularEstadoDeVencimiento(tarea.dueAt, tarea.plan.leadTimeDays) ===
        ExpirationStatus.EXPIRED;
      const fecha = tarea.dueAt
        ? tarea.dueAt.toLocaleDateString('es-AR', { timeZone: 'UTC' })
        : '-';
      pedirAvisoAlAdmin(this.events, this.logger, {
        distributorId,
        kind: vencida ? 'fleet_document_expired' : 'fleet_document_due',
        title: vencida
          ? `Vencido: ${tarea.plan.name}`
          : `Por vencer: ${tarea.plan.name}`,
        body: `${this.sujeto(tarea)} — ${vencida ? 'venció' : 'vence'} el ${fecha}`,
        link: { entity: 'fleet-task', id: tarea.taskId },
        // Con la fecha: si se reprograma el vencimiento, la nueva vuelve a avisar.
        dedupeKey: `fleet-task:${tarea.taskId}:${vencida ? 'expired' : 'due'}:${tarea.dueAt?.toISOString().slice(0, 10) ?? 'sin-fecha'}`,
      });
    }
    for (const { empleado, planes } of faltantes) {
      for (const plan of planes) {
        pedirAvisoAlAdmin(this.events, this.logger, {
          distributorId,
          kind: 'employee_document_missing',
          title: `Falta cargar: ${plan.name}`,
          body: `${empleado.firstName} ${empleado.lastName} no tiene cargado un documento que bloquea el despacho`,
          link: { entity: 'employee', id: empleado.employeeId },
          // Una vez por mes mientras siga faltando (el mail lo repite a diario).
          dedupeKey: `missing-doc:${empleado.employeeId}:${plan.planId}:${new Date().toISOString().slice(0, 7)}`,
        });
      }
    }
  }

  private mensaje(tareas: MaintenanceTask[], faltantes: FaltanteDeChofer[]) {
    return mensajeDeVencimientos(
      tareas.map((t) => ({
        que: t.plan.name,
        sujeto: this.sujeto(t),
        vence: t.dueAt ? t.dueAt.toLocaleDateString('es-AR') : '-',
      })),
      faltantes.map(({ empleado, planes }) => ({
        chofer: `${empleado.firstName} ${empleado.lastName}`,
        faltan: planes.map((p) => p.name),
      })),
    );
  }

  private sujeto(t: MaintenanceTask): string {
    if (t.car) return `Vehículo ${t.car.carPatent ?? t.carId}`;
    if (t.employee)
      return `Empleado ${t.employee.firstName} ${t.employee.lastName}`;
    return `Chofer ${t.delivery?.user?.fullName ?? t.deliveryId}`;
  }
}
