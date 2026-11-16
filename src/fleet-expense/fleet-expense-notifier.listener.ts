import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AdminService } from '../admin/admin.service';
import { errorMessage } from '../common/errors/error-message';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { armarCorreo, MensajeDeCorreo } from '../email/layout/correo';
import {
  marcaDeDistribuidora,
  nombreDeDistribuidoraDeAdmins,
} from '../email/layout/marca-de-correo';
import {
  mensajeDeAsignacionPendiente,
  mensajeDeCargaAnomala,
  mensajeDeDerrame,
} from './correos-de-gastos-de-flota';
import { CarService } from '../car/car.service';
import {
  CargaDeCombustibleAnomalaEvent,
  EVENTO_CARGA_ANOMALA,
  EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE,
  EVENTO_SINIESTRO_CON_DERRAME,
  SiniestroConAsignacionPendienteEvent,
  SiniestroConDerrameEvent,
} from './events/fleet-expense.events';

/**
 * Avisos inmediatos por correo a los administradores: consumo anómalo de una
 * carga de combustible (CU-195) y derrame de gas en un siniestro (CU-201).
 * Es un aviso: si el envío falla se registra y no deshace lo ya guardado.
 */
@Injectable()
export class FleetExpenseNotifierListener {
  private readonly logger = new Logger(FleetExpenseNotifierListener.name);

  constructor(
    private readonly cars: CarService,
    private readonly admins: AdminService,
    private readonly emailSender: EmailSenderPort,
  ) {}

  @OnEvent(EVENTO_CARGA_ANOMALA)
  async cargaAnomala(evento: CargaDeCombustibleAnomalaEvent): Promise<void> {
    const patente = await this.patente(evento.carId, evento.distributorId);
    await this.avisar(
      evento.distributorId,
      mensajeDeCargaAnomala(patente, evento.fuelLoadId),
    );
  }

  @OnEvent(EVENTO_SINIESTRO_CON_DERRAME)
  async derrame(evento: SiniestroConDerrameEvent): Promise<void> {
    const patente = await this.patente(evento.carId, evento.distributorId);
    await this.avisar(
      evento.distributorId,
      mensajeDeDerrame(patente, evento.accidentId),
    );
  }

  @OnEvent(EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE)
  async asignacionPendiente(
    evento: SiniestroConAsignacionPendienteEvent,
  ): Promise<void> {
    const patente = await this.patente(evento.carId, evento.distributorId);
    await this.avisar(
      evento.distributorId,
      mensajeDeAsignacionPendiente(patente, evento.accidentId, evento.motivo),
    );
  }

  private async patente(carId: string, distributorId: string): Promise<string> {
    try {
      const car = await this.cars.findOne(carId, distributorId);
      return car.carPatent ?? carId;
    } catch {
      return carId;
    }
  }

  private async avisar(
    distributorId: string,
    mensaje: MensajeDeCorreo,
  ): Promise<void> {
    try {
      const admins = await this.admins.findAll(distributorId);
      const destinatarios = admins
        .map((a) => a.user?.email)
        .filter((email): email is string => Boolean(email));
      const { asunto, html, text } = armarCorreo(
        marcaDeDistribuidora(nombreDeDistribuidoraDeAdmins(admins)),
        mensaje,
      );
      await Promise.all(
        destinatarios.map((to) =>
          this.emailSender.send({ to, subject: asunto, html, text }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo enviar el aviso "${mensaje.asunto}" a la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }
}
