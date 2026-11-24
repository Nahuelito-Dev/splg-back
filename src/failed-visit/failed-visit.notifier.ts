import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../common/events/aviso-al-admin';
import { errorMessage } from '../common/errors/error-message';
import { armarCorreo } from '../email/layout/correo';
import { MarcasDeCorreo } from '../email/marcas-de-correo.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { AdminGateway } from '../gateways/admin.gateway';
import { CustomersGateway } from '../gateways/customers.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { diaLegible } from '../route-batch/application/route-sheet-notifier.service';
import { RevisitStatus } from './domain/nueva-visita';

/** Lo que hace falta del pedido para avisar su nueva visita. */
export interface PedidoParaAvisar {
  orderId: string;
  distributorId: string;
  customerId: string;
  failedVisitCount: number;
  revisitStatus: string | null;
  scheduledDate?: string | null;
  timeSlotId: string | null;
}

interface FranjaDelAviso {
  name: string;
  startTime: string;
  endTime: string;
}

const hhmm = (hora: string): string => hora.slice(0, 5);

/** «el jueves 20/11 entre las 09:00 y las 13:00» (sin franja, sólo el día). */
export function cuandoLegible(
  fecha: string,
  franja: Pick<FranjaDelAviso, 'startTime' | 'endTime'> | null,
): string {
  const dia = `el ${diaLegible(fecha)}`;
  return franja
    ? `${dia} entre las ${hhmm(franja.startTime)} y las ${hhmm(franja.endTime)}`
    : dia;
}

/**
 * Avisos de la nueva visita (C5): al cliente por su sala del socket, push y
 * correo; al admin en el panel (socket) y en la bandeja cuando tiene que
 * decidir. Best-effort: el hecho ya ocurrió, un aviso que falla se registra.
 */
@Injectable()
export class FailedVisitNotifier {
  private readonly logger = new Logger(FailedVisitNotifier.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly customers: CustomersGateway,
    private readonly admins: AdminGateway,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
    private readonly correo: EmailSenderPort,
    private readonly marcas: MarcasDeCorreo,
  ) {}

  /**
   * Después de una visita fallida: «No te encontramos. Volvemos el jueves 20
   * entre las 9 y las 13» con la invitación a contestar, o —si decide el
   * admin— que la distribuidora se va a comunicar.
   */
  async visitaFallida(
    p: PedidoParaAvisar,
    motivo: string,
    {
      deHoja = false,
      adminYaAvisado = false,
    }: { deHoja?: boolean; adminYaAvisado?: boolean } = {},
  ): Promise<void> {
    const corto = idCortoDePedido(p.orderId);
    const franja = await this.franja(p.timeSlotId);
    // Un solo aviso por hecho en la campana del panel: la hoja de ruta ya avisó
    // la parada fallida (`route-sheet:stop-failed`), así que acá sólo se pide
    // refrescar; el pedido suelto avisa con `order:failed-visit`.
    this.alPanel(p, deHoja ? 'order:revisit-updated' : 'order:failed-visit', {
      reason: motivo,
    });

    if (p.revisitStatus === RevisitStatus.AWAITING_ADMIN || !p.scheduledDate) {
      this.alCliente(p, 'order:delivery-failed', {
        orderId: p.orderId,
        attempt: p.failedVisitCount,
        revisitStatus: RevisitStatus.AWAITING_ADMIN,
      });
      const texto =
        'Pasamos y no pudimos entregarte el pedido. La distribuidora se va a comunicar con vos para coordinar la entrega.';
      await this.notifications.sendOrderNoticePush(p.customerId, p.orderId, {
        title: 'No pudimos entregarte el pedido',
        body: texto,
        event: 'ORDER_DELIVERY_FAILED',
      });
      await this.correoAlCliente(p, {
        asunto: 'No pudimos entregarte el pedido',
        titulo: 'No te encontramos',
        texto,
      });
      // Si la hoja no encontró día ya le pidió la decisión al admin: no se repite.
      if (adminYaAvisado) return;
      pedirAvisoAlAdmin(this.events, this.logger, {
        distributorId: p.distributorId,
        kind: 'order_failed_visit_needs_admin',
        title: 'Entrega fallida: decidí la nueva visita',
        body: `El pedido ${corto} lleva ${p.failedVisitCount} ${p.failedVisitCount === 1 ? 'visita fallida' : 'visitas fallidas'} (${motivo}). Fijale día y franja, reasignalo o cancelalo: no vuelve solo al despacho.`,
        link: { entity: 'order', id: p.orderId },
        dedupeKey: `order-failed-visit:${p.orderId}:${p.failedVisitCount}`,
      });
      return;
    }

    const cuando = cuandoLegible(p.scheduledDate, franja);
    const acordada = p.revisitStatus === RevisitStatus.CONFIRMED;
    this.alCliente(p, 'order:rescheduled', this.payload(p, franja));
    const texto = acordada
      ? `Pasamos y no pudimos entregarte el pedido. Como acordamos, volvemos ${cuando}.`
      : `Pasamos y no pudimos entregarte el pedido. Volvemos ${cuando}. Si no te sirve, elegí otro día y horario en la app.`;
    await this.notifications.sendOrderNoticePush(p.customerId, p.orderId, {
      title: 'No te encontramos',
      body: texto,
      event: 'ORDER_RESCHEDULED',
    });
    await this.correoAlCliente(p, {
      asunto: `No te encontramos: volvemos ${cuando}`,
      titulo: 'No te encontramos',
      texto,
    });
  }

  /** El cliente aceptó la propuesta o eligió otro día: se le confirma y lo ve el panel. */
  async respondida(p: PedidoParaAvisar, cambio: boolean): Promise<void> {
    const franja = await this.franja(p.timeSlotId);
    this.alCliente(p, 'order:rescheduled', this.payload(p, franja));
    this.alPanel(p, 'order:revisit-updated', {});
    if (!cambio || !p.scheduledDate) return;
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: p.distributorId,
      kind: 'order_revisit_changed_by_customer',
      title: 'El cliente eligió otro día para la entrega',
      body: `El pedido ${idCortoDePedido(p.orderId)} se entrega ${cuandoLegible(p.scheduledDate, franja)}.`,
      link: { entity: 'order', id: p.orderId },
      dedupeKey: `order-revisit-changed:${p.orderId}:${p.failedVisitCount}:${p.scheduledDate}:${p.timeSlotId ?? ''}`,
    });
  }

  /** El admin fijó el día y la franja: se le avisa al cliente (socket, push y correo). */
  async fijadaPorElAdmin(p: PedidoParaAvisar): Promise<void> {
    if (!p.scheduledDate) return;
    const franja = await this.franja(p.timeSlotId);
    const cuando = cuandoLegible(p.scheduledDate, franja);
    this.alCliente(p, 'order:rescheduled', this.payload(p, franja));
    this.alPanel(p, 'order:revisit-updated', {});
    const texto = `La distribuidora coordinó la entrega de tu pedido: pasamos ${cuando}.`;
    await this.notifications.sendOrderNoticePush(p.customerId, p.orderId, {
      title: 'Nueva fecha de entrega',
      body: texto,
      event: 'ORDER_RESCHEDULED',
    });
    await this.correoAlCliente(p, {
      asunto: `Tu pedido se entrega ${cuando}`,
      titulo: 'Nueva fecha de entrega',
      texto,
    });
  }

  private payload(
    p: PedidoParaAvisar,
    franja: FranjaDelAviso | null,
  ): Record<string, unknown> {
    return {
      orderId: p.orderId,
      scheduledDate: p.scheduledDate ?? null,
      timeSlotId: p.timeSlotId,
      timeSlotName: franja?.name ?? null,
      windowStart: franja?.startTime ?? null,
      windowEnd: franja?.endTime ?? null,
      revisitStatus: p.revisitStatus,
      failedVisitCount: p.failedVisitCount,
      canRespond: p.revisitStatus === RevisitStatus.PROPOSED,
    };
  }

  private alCliente(
    p: PedidoParaAvisar,
    evento: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      this.customers.notifyCustomer(p.customerId, evento, payload);
    } catch (error) {
      this.logger.warn(`Aviso ${evento} falló: ${errorMessage(error)}`);
    }
  }

  private alPanel(
    p: PedidoParaAvisar,
    evento: string,
    extra: Record<string, unknown>,
  ): void {
    try {
      this.admins.notifyAdmins(
        evento,
        {
          orderId: p.orderId,
          revisitStatus: p.revisitStatus,
          failedVisitCount: p.failedVisitCount,
          scheduledDate: p.scheduledDate ?? null,
          timeSlotId: p.timeSlotId,
          ...extra,
        },
        p.distributorId,
      );
    } catch (error) {
      this.logger.warn(`Aviso ${evento} falló: ${errorMessage(error)}`);
    }
  }

  private async franja(
    timeSlotId: string | null,
  ): Promise<FranjaDelAviso | null> {
    if (!timeSlotId) return null;
    try {
      const [f]: FranjaDelAviso[] = await this.dataSource.query(
        `SELECT "name", "startTime", "endTime" FROM "time_slot" WHERE "time_slot_id" = $1`,
        [timeSlotId],
      );
      return f ?? null;
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la franja ${timeSlotId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async correoAlCliente(
    p: PedidoParaAvisar,
    m: { asunto: string; titulo: string; texto: string },
  ): Promise<void> {
    try {
      const [u]: Array<{ email: string | null }> = await this.dataSource.query(
        `SELECT "email" FROM "user" WHERE "user_id" = $1`,
        [p.customerId],
      );
      if (!u?.email) return;
      const marca = await this.marcas.deDistribuidora(p.distributorId);
      const armado = armarCorreo(marca, {
        asunto: m.asunto,
        preheader: m.texto,
        etiqueta: `Pedido ${idCortoDePedido(p.orderId)}`,
        titulo: m.titulo,
        bloques: [
          { tipo: 'parrafo', texto: m.texto },
          {
            tipo: 'parrafo',
            suave: true,
            texto:
              'Podés ver el pedido y su nueva fecha en la app, en «Mis pedidos».',
          },
        ],
        motivo: 'Te escribimos porque tenés un pedido en curso.',
      });
      await this.correo.send({
        to: u.email,
        subject: armado.asunto,
        html: armado.html,
        text: armado.text,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo mandar el correo de la nueva visita del pedido ${p.orderId}: ${errorMessage(error)}`,
      );
    }
  }
}
