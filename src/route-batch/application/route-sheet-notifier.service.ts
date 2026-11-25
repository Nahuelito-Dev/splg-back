import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { errorMessage } from '../../common/errors/error-message';
import { FcmPort } from '../../firebase/ports/fcm.port';
import { AdminGateway } from '../../gateways/admin.gateway';
import { CustomersGateway } from '../../gateways/customers.gateway';
import { DriversGateway } from '../../gateways/drivers.gateway';
import { NotificationsService } from '../../notifications/notifications.service';
import type { EfectivoDeSalida } from '../../order/domain/efectivo-a-cobrar';

/** Por qué cambió la hoja en curso (lo que la app del chofer le muestra). */
export type MotivoDeCambio =
  | 'stop_removed'
  | 'stop_added'
  | 'stop_failed'
  | 'reordered';

const HORA = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DIAS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/** «lunes 16/11» para una fecha AAAA-MM-DD. */
export const diaLegible = (fecha: string): string => {
  const [, mes, dia] = fecha.split('-');
  const semana = DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];
  return `${semana} ${dia}/${mes}`;
};

/** La franja estimada que se le comunica al cliente (ms). */
export interface FranjaEstimada {
  windowStartMs: number;
  windowEndMs: number;
  etaMs: number;
}

/** «10:15» en hora argentina. */
export const horaArgentina = (ms: number): string => HORA.format(new Date(ms));

/**
 * Los avisos de la hoja de ruta en curso (§11): al chofer por su sala del
 * socket (y push si la hoja cambió), al panel por la sala de la distribuidora
 * (y la bandeja para lo que pide una decisión) y al cliente por su sala y push.
 * Todo best-effort: el hecho ya ocurrió; un aviso que falla se registra.
 */
@Injectable()
export class RouteSheetNotifier {
  private readonly logger = new Logger(RouteSheetNotifier.name);

  constructor(
    private readonly drivers: DriversGateway,
    private readonly admins: AdminGateway,
    private readonly customers: CustomersGateway,
    private readonly notifications: NotificationsService,
    private readonly fcm: FcmPort,
    private readonly events: EventEmitter2,
  ) {}

  /** Al chofer: la hoja empezó, cambió o se cerró. */
  alChofer(
    driverUserId: string,
    evento:
      | 'route-sheet:assigned'
      | 'route-sheet:started'
      | 'route-sheet:changed'
      | 'route-sheet:wait-expired'
      | 'route-sheet:closed',
    payload: Record<string, unknown>,
  ): void {
    this.seguro(evento, () =>
      this.drivers.notifyRouteBatch(driverUserId, evento, payload),
    );
  }

  /** Push al chofer cuando la hoja en curso cambió (D-05: sólo aviso). */
  async pushAlChofer(
    destino: { distributorId: string; driverUserId: string | null },
    token: string | null | undefined,
    sheetId: string,
    body: string,
    title = 'Tu hoja de ruta cambió',
    type = 'ROUTE_SHEET_CHANGED',
  ): Promise<void> {
    if (!token) return;
    try {
      await this.fcm.sendToToken(
        token,
        {
          notification: { title, body },
          data: { type, sheetId },
          android: { priority: 'high' },
          apns: { headers: { 'apns-priority': '10' } },
        },
        {
          type,
          distributorId: destino.distributorId,
          recipientUserId: destino.driverUserId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el push de la hoja ${sheetId}: ${errorMessage(error)}`,
      );
    }
  }

  /** Al panel de la distribuidora (seguimiento en vivo). */
  alPanel(
    distributorId: string,
    evento:
      | 'route-sheet:updated'
      | 'route-sheet:assigned'
      | 'route-sheet:started'
      | 'route-sheet:driver-location'
      | 'route-sheet:wait-expired'
      | 'route-sheet:stop-progress'
      | 'route-sheet:stop-failed'
      | 'route-sheet:eta-updated'
      | 'route-sheet:stop-late'
      | 'route-sheet:closed',
    payload: Record<string, unknown>,
  ): void {
    this.seguro(evento, () =>
      this.admins.notifyAdmins(evento, payload, distributorId),
    );
  }

  /** A la bandeja del admin: algo que pide una decisión (reprogramar una parada no entregada). */
  aLaBandeja(
    distributorId: string,
    aviso: { kind: string; title: string; body: string; dedupeKey: string },
  ): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId,
      kind: aviso.kind,
      title: aviso.title,
      body: aviso.body,
      link: null,
      dedupeKey: aviso.dedupeKey,
    });
  }

  /** Al cliente: la franja estimada de su pedido (socket siempre; push si se le avisa). */
  async franjaAlCliente(
    customerUserId: string,
    orderId: string,
    franja: { windowStartMs: number; windowEndMs: number; etaMs: number },
    push: boolean,
    distributorId?: string | null,
  ): Promise<void> {
    const payload = {
      orderId,
      windowStart: new Date(franja.windowStartMs).toISOString(),
      windowEnd: new Date(franja.windowEndMs).toISOString(),
      etaAt: new Date(franja.etaMs).toISOString(),
    };
    this.seguro('order:eta-updated', () =>
      this.customers.notifyCustomer(
        customerUserId,
        'order:eta-updated',
        payload,
      ),
    );
    if (!push) return;
    await this.notifications.sendOrderNoticePush(
      customerUserId,
      orderId,
      {
        title: 'Horario estimado de tu pedido',
        body: `Te llega entre las ${horaArgentina(franja.windowStartMs)} y las ${horaArgentina(franja.windowEndMs)}.`,
        event: 'ORDER_ETA_UPDATED',
      },
      undefined,
      distributorId,
    );
  }

  /**
   * Al iniciar el viaje, a cada cliente de la hoja: su pedido está en camino y
   * la franja estimada (socket y push, siempre).
   */
  async salidaAlCliente(
    customerUserId: string,
    orderId: string,
    franja: { windowStartMs: number; windowEndMs: number; etaMs: number },
    efectivo?: EfectivoDeSalida,
    distributorId?: string | null,
  ): Promise<void> {
    this.seguro('order:eta-updated', () =>
      this.customers.notifyCustomer(customerUserId, 'order:eta-updated', {
        orderId,
        windowStart: new Date(franja.windowStartMs).toISOString(),
        windowEnd: new Date(franja.windowEndMs).toISOString(),
        etaAt: new Date(franja.etaMs).toISOString(),
      }),
    );
    // Con efectivo a cobrar, el mismo push suma «tené listos $X»: un solo aviso por parada.
    await this.notifications.sendOrderNoticePush(
      customerUserId,
      orderId,
      {
        title: 'Tu pedido está en camino',
        body: `El chofer salió con tu pedido: te llega entre las ${horaArgentina(franja.windowStartMs)} y las ${horaArgentina(franja.windowEndMs)}.`,
        event: 'ORDER_TRIP_STARTED',
      },
      efectivo,
      distributorId,
    );
  }

  /**
   * Al cliente cuando no se le pudo entregar: en el primer intento, el chofer
   * vuelve a pasar al final de su recorrido; en el segundo, la distribuidora se
   * va a comunicar para coordinar.
   */
  async noEntregadoAlCliente(
    customerUserId: string,
    orderId: string,
    intento: 1 | 2,
    distributorId?: string | null,
  ): Promise<void> {
    this.seguro('order:delivery-failed', () =>
      this.customers.notifyCustomer(customerUserId, 'order:delivery-failed', {
        orderId,
        attempt: intento,
      }),
    );
    await this.notifications.sendOrderNoticePush(
      customerUserId,
      orderId,
      intento === 1
        ? {
            title: 'No pudimos entregarte el pedido',
            body: 'El chofer pasó y no pudo entregarlo. Vuelve a pasar más tarde en su recorrido de hoy.',
            event: 'ORDER_DELIVERY_RETRY',
          }
        : {
            title: 'No pudimos entregarte el pedido',
            body: 'El chofer volvió a pasar y no pudo entregarlo. La distribuidora se va a comunicar con vos para coordinar la entrega.',
            event: 'ORDER_DELIVERY_FAILED',
          },
      undefined,
      distributorId,
    );
  }

  /**
   * Al cliente cuando no se le pudo entregar en el primer intento: su pedido se
   * reprogramó para más tarde en el recorrido de hoy, con la franja estimada
   * nueva (socket y push).
   */
  async postergadoAlCliente(
    customerUserId: string,
    orderId: string,
    franja: FranjaEstimada,
    distributorId?: string | null,
  ): Promise<void> {
    const payload = {
      orderId,
      windowStart: new Date(franja.windowStartMs).toISOString(),
      windowEnd: new Date(franja.windowEndMs).toISOString(),
      etaAt: new Date(franja.etaMs).toISOString(),
    };
    this.seguro('order:delivery-failed', () =>
      this.customers.notifyCustomer(customerUserId, 'order:delivery-failed', {
        ...payload,
        attempt: 1,
      }),
    );
    this.seguro('order:eta-updated', () =>
      this.customers.notifyCustomer(
        customerUserId,
        'order:eta-updated',
        payload,
      ),
    );
    await this.notifications.sendOrderNoticePush(
      customerUserId,
      orderId,
      {
        title: 'Reprogramamos tu pedido para más tarde',
        body: `El chofer pasó y no pudo entregarlo. Vuelve a pasar hoy: te llega entre las ${horaArgentina(franja.windowStartMs)} y las ${horaArgentina(franja.windowEndMs)}.`,
        event: 'ORDER_DELIVERY_RETRY',
      },
      undefined,
      distributorId,
    );
  }

  /**
   * Al confirmarse la hoja del día, al cliente de un pedido SIN franja fija (lo
   * reprogramó la hoja de ruta): el horario estimado de ese día (socket y push).
   */
  async horarioAlCliente(
    customerUserId: string,
    orderId: string,
    fecha: string,
    franja: FranjaEstimada,
    distributorId?: string | null,
  ): Promise<void> {
    this.seguro('order:eta-updated', () =>
      this.customers.notifyCustomer(customerUserId, 'order:eta-updated', {
        orderId,
        scheduledDate: fecha,
        windowStart: new Date(franja.windowStartMs).toISOString(),
        windowEnd: new Date(franja.windowEndMs).toISOString(),
        etaAt: new Date(franja.etaMs).toISOString(),
      }),
    );
    await this.notifications.sendOrderNoticePush(
      customerUserId,
      orderId,
      {
        title: 'Ya tenemos el horario de tu pedido',
        body: `El ${diaLegible(fecha)} te llega entre las ${horaArgentina(franja.windowStartMs)} y las ${horaArgentina(franja.windowEndMs)}.`,
        event: 'ORDER_ETA_UPDATED',
      },
      undefined,
      distributorId,
    );
  }

  /** Al cliente: su pedido se reprogramó solo para otro día (socket y push). */
  async reprogramadoAlCliente(
    customerUserId: string,
    orderId: string,
    fecha: string,
    distributorId?: string | null,
  ): Promise<void> {
    this.seguro('order:rescheduled', () =>
      this.customers.notifyCustomer(customerUserId, 'order:rescheduled', {
        orderId,
        scheduledDate: fecha,
      }),
    );
    await this.notifications.sendOrderNoticePush(
      customerUserId,
      orderId,
      {
        title: 'Reprogramamos tu pedido',
        body: `No pudimos entregártelo hoy: lo reprogramamos para el ${diaLegible(fecha)}. Te avisamos el horario cuando se arme el recorrido de ese día.`,
        event: 'ORDER_RESCHEDULED',
      },
      undefined,
      distributorId,
    );
  }

  private seguro(canal: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn(`Aviso ${canal} falló: ${errorMessage(error)}`);
    }
  }
}
