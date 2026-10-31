import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  diaArgentino,
  minutosDelDiaArgentino,
  sumarDias,
} from '../common/utils/dias-argentina';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { CreateOrderDto } from '../order/dto/create-order.dto';
import { Order } from '../order/entities/order.entity';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { OrderService } from '../order/order.service';
import { RedisService } from '../redis/redis.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
} from './entities/repurchase-invitation.entity';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseNotifier } from './repurchase-notifier';

const CERROJO_TTL_MS = 30_000;
const CERROJO_ESPERA_MS = 10_000;
/** Cuánto se recuerda el pedido que creó una invitación, por si falló el registro de la aceptación. */
const PEDIDO_CREADO_TTL_SEG = 7 * 86_400;

export interface InvitacionAceptada {
  invitation: RepurchaseInvitation;
  order: Order;
  paymentUrl?: string;
}

/**
 * El cliente acepta o descarta una invitación de recompra (CU-106). Aceptar
 * crea el pedido por el mismo camino que cualquier pedido de la app
 * (`OrderService.create`), con su reserva de stock, su cotización al precio de
 * hoy y su despacho. Aceptar y descartar toman el mismo cerrojo en Redis por
 * invitación: una sola respuesta a la vez, y la segunda encuentra la invitación
 * ya cerrada.
 */
@Injectable()
export class RepurchaseAcceptService {
  private readonly logger = new Logger(RepurchaseAcceptService.name);

  constructor(
    private readonly invitaciones: RepurchaseInvitationService,
    private readonly orders: OrderService,
    private readonly pedidos: OrderLookupService,
    private readonly notifier: RepurchaseNotifier,
    private readonly redis: RedisService,
    private readonly distribuidoras: DistributorService,
    private readonly franjas: TimeSlotService,
  ) {}

  async aceptar(
    invitationId: string,
    userId: string,
    cuerpo: AcceptInvitationDto,
    ahora: Date = new Date(),
  ): Promise<InvitacionAceptada> {
    if (Boolean(cuerpo.timeSlotId) !== Boolean(cuerpo.scheduledDate)) {
      throw new BadRequestException(
        'timeSlotId y scheduledDate van juntos: mandá los dos para agendar la entrega, o ninguno para usar tu franja habitual (si no, la entrega es inmediata)',
      );
    }
    return this.conCerrojo(invitationId, () =>
      this.aceptarConCerrojo(invitationId, userId, cuerpo, ahora),
    );
  }

  /** Descartar toma el mismo cerrojo que aceptar: no se pisan. */
  descartar(
    invitationId: string,
    userId: string,
    ahora: Date = new Date(),
  ): Promise<RepurchaseInvitation> {
    return this.conCerrojo(invitationId, () =>
      this.invitaciones.descartar(invitationId, userId, ahora),
    );
  }

  private async conCerrojo<T>(
    invitationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const turno = await this.redis.withLock(
      `repurchase:accept:${invitationId}`,
      CERROJO_TTL_MS,
      fn,
      CERROJO_ESPERA_MS,
    );
    if (!turno.obtenido) {
      throw new ConflictException(
        'La invitación se está procesando: reintentá en unos segundos',
      );
    }
    return turno.valor;
  }

  private async aceptarConCerrojo(
    invitationId: string,
    userId: string,
    cuerpo: AcceptInvitationDto,
    ahora: Date,
  ): Promise<InvitacionAceptada> {
    const invitacion = await this.invitaciones.delCliente(invitationId, userId);
    // Un primer intento creó el pedido y falló al registrarlo: se lo reconoce.
    const creado = await this.redis.get(this.claveDelPedido(invitationId));
    if (creado && invitacion.status !== RepurchaseInvitationStatus.ACCEPTED) {
      return this.registrar(
        invitacion,
        await this.orders.findOne(creado),
        undefined,
        ahora,
      );
    }
    this.invitaciones.exigirAbierta(invitacion);
    await this.exigirDistribuidoraActiva(invitacion);
    if (invitacion.expiresAt.getTime() <= ahora.getTime()) {
      const vencidas = await this.invitaciones.vencerVencidas(
        ahora,
        invitacion.distributorId,
      );
      for (const vencida of vencidas) {
        await this.notifier.cerrada(vencida, 'expired');
      }
      throw new ConflictException('La invitación venció');
    }
    if (
      await this.pedidos.hayPedidoDesde(
        invitacion.distributorId,
        userId,
        invitacion.createdAt,
      )
    ) {
      await this.invitaciones.cancelar(invitationId, ahora);
      await this.notifier.cerrada(invitacion, 'cancelled');
      throw new ConflictException(
        'La invitación se cerró porque ya hiciste un pedido',
      );
    }
    if (!invitacion.addressId) {
      throw new ConflictException(
        'La dirección de la invitación ya no existe: hacé el pedido desde la app',
      );
    }

    const entrega = await this.entregaDe(invitacion, cuerpo, ahora);
    const dto = new CreateOrderDto();
    dto.customerId = userId;
    dto.addressId = invitacion.addressId;
    dto.items = invitacion.suggestedItems.map((i) => ({
      gasCylinderId: i.gasCylinderId,
      quantity: i.quantity,
      unitPrice: 0,
    }));
    dto.paymentMethod = cuerpo.paymentMethod ?? invitacion.paymentMethod;
    dto.timeSlotId = entrega?.timeSlotId;
    dto.scheduledDate = entrega?.scheduledDate;
    dto.notes = cuerpo.notes;

    const { order, paymentUrl } = await withTransactionRetry(
      () => this.orders.create(dto, invitacion.distributorId),
      { context: 'RepurchaseAcceptService.aceptar' },
    );
    // Antes de registrar: si eso falla, el reintento reconoce el pedido propio.
    await this.redis.setex(
      this.claveDelPedido(invitationId),
      PEDIDO_CREADO_TTL_SEG,
      order.orderId,
    );
    return this.registrar(invitacion, order, paymentUrl, ahora);
  }

  private async registrar(
    invitacion: RepurchaseInvitation,
    order: Order,
    paymentUrl: string | undefined,
    ahora: Date,
  ): Promise<InvitacionAceptada> {
    const aceptada = await this.invitaciones.aceptada(
      invitacion.invitationId,
      order.orderId,
      ahora,
    );
    await this.redis.del(this.claveDelPedido(invitacion.invitationId));
    this.logger.log(
      `Invitación ${invitacion.invitationId} aceptada por ${invitacion.userId}: pedido ${order.orderId}`,
    );
    return { invitation: aceptada, order, paymentUrl };
  }

  private claveDelPedido(invitationId: string): string {
    return `repurchase:accepted-order:${invitationId}`;
  }

  /** Una distribuidora suspendida no recibe pedidos: la invitación no se puede aceptar. */
  private async exigirDistribuidoraActiva(
    invitacion: RepurchaseInvitation,
  ): Promise<void> {
    const distribuidora = await this.distribuidoras.findOne(
      invitacion.distributorId,
    );
    if (distribuidora.status !== DistributorStatus.ACTIVE) {
      throw new ConflictException(
        'La distribuidora no está disponible en este momento: no se puede aceptar la invitación',
      );
    }
  }

  /**
   * La entrega del pedido: la que el cliente eligió (franja y fecha juntas) o,
   * si no mandó ninguna, su franja habitual de la invitación si sigue activa
   * (hoy si todavía no terminó, si no mañana). Sin franja, entrega inmediata.
   */
  private async entregaDe(
    invitacion: RepurchaseInvitation,
    cuerpo: AcceptInvitationDto,
    ahora: Date,
  ): Promise<{ timeSlotId: string; scheduledDate: string } | null> {
    if (cuerpo.timeSlotId && cuerpo.scheduledDate) {
      return {
        timeSlotId: cuerpo.timeSlotId,
        scheduledDate: cuerpo.scheduledDate,
      };
    }
    if (!invitacion.timeSlotId) return null;
    let franja;
    try {
      franja = await this.franjas.findOne(
        invitacion.timeSlotId,
        invitacion.distributorId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
    if (!franja.isActive) return null;
    const [h, m] = franja.endTime.split(':').map(Number);
    const hoy = diaArgentino(ahora);
    const terminaHoy = h * 60 + m > minutosDelDiaArgentino(ahora);
    return {
      timeSlotId: franja.timeSlotId,
      scheduledDate: terminaHoy ? hoy : sumarDias(hoy, 1),
    };
  }
}
