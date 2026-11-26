import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AttendanceService } from './attendance.service';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { EmployeeAttendance } from './entities/employee-attendance.entity';
import { errorMessage } from '../common/errors/error-message';
import { armarCorreo } from '../email/layout/correo';
import {
  marcaDeDistribuidora,
  nombreDeDistribuidoraDeAdmins,
} from '../email/layout/marca-de-correo';
import { mensajeDeJornadasSinCerrar } from './correo-jornadas-sin-cerrar';
import { ZONA_ARGENTINA, diaArgentino } from '../common/utils/dias-argentina';
import { ConRegistro } from '../process-run/process-run.recorder';
import { registrarErrorAtrapado } from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';

/**
 * Aviso de las 7 de la mañana (hora argentina, CU-189): las jornadas de
 * días anteriores que siguen abiertas, por correo a los administradores de cada
 * distribuidora. No las cierra: el sistema no sabe a qué hora terminó la
 * persona. Las corrige el administrador (CU-313). No marca nada: corre una vez
 * por día y el panel sigue mostrando lo que queda sin cerrar.
 */
@Injectable()
export class AttendanceOpenAlertCron {
  private readonly logger = new Logger(AttendanceOpenAlertCron.name);

  constructor(
    private readonly attendance: AttendanceService,
    private readonly adminService: AdminService,
    private readonly emailSender: EmailSenderPort,
  ) {}

  @Cron('0 7 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.ATTENDANCE_OPEN_ALERT)
  async avisarJornadasSinCerrar(): Promise<void> {
    const hoy = diaArgentino();
    const abiertas = await this.attendance.abiertasAnteriores(hoy);
    if (abiertas.length === 0) return;

    const porDistribuidora = new Map<string, EmployeeAttendance[]>();
    for (const jornada of abiertas) {
      const lista = porDistribuidora.get(jornada.distributorId) ?? [];
      lista.push(jornada);
      porDistribuidora.set(jornada.distributorId, lista);
    }

    for (const [distributorId, jornadas] of porDistribuidora) {
      try {
        const admins = await this.adminService.findAll(distributorId);
        const destinatarios = admins
          .map((a) => a.user?.email)
          .filter((email): email is string => Boolean(email));
        const correo = armarCorreo(
          marcaDeDistribuidora(nombreDeDistribuidoraDeAdmins(admins)),
          this.mensaje(jornadas),
        );
        await Promise.all(
          destinatarios.map((to) =>
            this.emailSender.send({
              to,
              subject: correo.asunto,
              html: correo.html,
              text: correo.text,
              registro: { type: 'ATTENDANCE_OPEN', distributorId },
            }),
          ),
        );
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `No se pudo avisar las jornadas sin cerrar de la distribuidora ${distributorId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private mensaje(jornadas: EmployeeAttendance[]) {
    return mensajeDeJornadasSinCerrar(
      jornadas.map((j) => {
        const e = j.employee;
        return {
          persona: e ? `${e.firstName} ${e.lastName}` : j.employeeId,
          dia: j.workDate,
          ingreso: j.checkInAt.toLocaleTimeString('es-AR', {
            timeZone: ZONA_ARGENTINA,
            hour: '2-digit',
            minute: '2-digit',
          }),
        };
      }),
    );
  }
}
