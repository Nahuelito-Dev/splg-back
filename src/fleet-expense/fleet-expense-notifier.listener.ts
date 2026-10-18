import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AdminService } from '../admin/admin.service';
import { escaparHtml } from '../common/utils/html.util';
import { errorMessage } from '../common/errors/error-message';
import { EmailSenderPort } from '../email/ports/email-sender.port';
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
      `Consumo de combustible anómalo: ${patente}`,
      `<p>La última carga de combustible del vehículo ${escaparHtml(patente)} tiene un consumo que se aparta más de un 25 % del habitual. Revisala en el panel de flota (carga ${escaparHtml(evento.fuelLoadId)}).</p>`,
    );
  }

  @OnEvent(EVENTO_SINIESTRO_CON_DERRAME)
  async derrame(evento: SiniestroConDerrameEvent): Promise<void> {
    const patente = await this.patente(evento.carId, evento.distributorId);
    await this.avisar(
      evento.distributorId,
      `URGENTE: derrame de gas en un siniestro (${patente})`,
      `<p>Se registró un siniestro con fuga o derrame de gas del vehículo ${escaparHtml(patente)} (siniestro ${escaparHtml(evento.accidentId)}). Es un incidente de seguridad: revisalo ahora en el panel de flota.</p>`,
    );
  }

  @OnEvent(EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE)
  async asignacionPendiente(
    evento: SiniestroConAsignacionPendienteEvent,
  ): Promise<void> {
    const patente = await this.patente(evento.carId, evento.distributorId);
    await this.avisar(
      evento.distributorId,
      `Vehículo fuera de servicio con el chofer en entrega (${patente})`,
      `<p>El vehículo ${escaparHtml(patente)} quedó fuera de servicio por un siniestro (${escaparHtml(evento.accidentId)}), pero sigue asignado a su chofer: ${escaparHtml(evento.motivo)}.</p>`,
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
    subject: string,
    html: string,
  ): Promise<void> {
    try {
      const admins = await this.admins.findAll(distributorId);
      const destinatarios = admins
        .map((a) => a.user?.email)
        .filter((email): email is string => Boolean(email));
      await Promise.all(
        destinatarios.map((to) => this.emailSender.send({ to, subject, html })),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo enviar el aviso "${subject}" a la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }
}
