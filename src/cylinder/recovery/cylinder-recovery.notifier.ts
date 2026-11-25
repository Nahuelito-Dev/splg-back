import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomersService } from '../../customer/customer.service';
import { FcmPort } from '../../firebase/ports/fcm.port';
import { CustomersGateway } from '../../gateways/customers.gateway';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';

/** Evento de socket con el que el cliente recibe cada aviso del recupero. */
export const EVENTO_AVISO_DE_RECUPERO = 'cylinder-recovery:notice';

/** Tipo de aviso para la bandeja del administrador. */
export const AVISO_RECUPERO_ESCALADO = 'cylinder_recovery_escalated';

/** Entidad a la que lleva el aviso del administrador. */
export const ENTIDAD_CASO_DE_RECUPERO = 'cylinder-recovery-case';

/** Lo que los textos necesitan saber del caso. */
export interface ContextoDelRecupero {
  serial: string;
  /** Días que el envase lleva en poder del cliente. */
  diasAfuera: number;
  /** Para la oferta de retiro: el día agendado de la entrega. */
  entregaProgramada?: string;
  customerName?: string | null;
}

function pesos(n: number): string {
  return n.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function cuando(fecha: Date): string {
  return fecha.toLocaleString('es-AR', {
    timeZone: ZONA_ARGENTINA,
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

/** Título y cuerpo de cada aviso al cliente. */
export function textoDelAviso(
  caso: CylinderRecoveryCase,
  aviso: CylinderRecoveryNotice,
  ctx: ContextoDelRecupero,
): { title: string; body: string } {
  switch (aviso.kind) {
    case RecoveryNoticeKind.REMINDER:
      return {
        title: 'Devolvé tu envase',
        body: `Tenés el envase ${ctx.serial} desde hace ${ctx.diasAfuera} días. Devolvelo en tu próxima entrega o acercalo al depósito.`,
      };
    case RecoveryNoticeKind.DEPOSIT_WARNING:
      return {
        title: 'Tu depósito está comprometido',
        body: `El envase ${ctx.serial} sigue sin volver. Si no lo devolvés antes del ${cuando(aviso.expiresAt)}, el depósito de ${pesos(caso.depositAmount)} puede quedar a cargo tuyo.`,
      };
    case RecoveryNoticeKind.PICKUP_OFFER:
      return {
        title: '¿Devolvés el envase en tu próxima entrega?',
        body: `El ${ctx.entregaProgramada ?? 'día de tu entrega'} te llevamos tu pedido: el chofer puede retirar el envase ${ctx.serial} en ese mismo viaje. Aceptá antes del ${cuando(aviso.expiresAt)}.`,
      };
  }
}

/** Un aviso listo para el cliente, con el caso y el contexto de los textos. */
export interface AvisoParaElCliente {
  caso: CylinderRecoveryCase;
  aviso: CylinderRecoveryNotice;
  ctx: ContextoDelRecupero;
}

/** El push de varios avisos juntos: cuántos envases y, si hay oferta de retiro, que la puede aceptar. */
export function textoResumen(avisos: AvisoParaElCliente[]): {
  title: string;
  body: string;
} {
  const casos = new Map(avisos.map((a) => [a.caso.caseId, a.ctx.serial]));
  const hayOferta = avisos.some(
    (a) => a.aviso.kind === RecoveryNoticeKind.PICKUP_OFFER,
  );
  const envases = [...casos.values()];
  const lista =
    envases.length <= 3
      ? envases.join(', ')
      : `${envases.slice(0, 3).join(', ')} y ${envases.length - 3} más`;
  return {
    title:
      envases.length === 1
        ? 'Devolvé tu envase'
        : `Tenés ${envases.length} envases sin devolver`,
    body:
      `Envases: ${lista}. Devolvelos en tu próxima entrega o acercalos al depósito.` +
      (hayOferta
        ? ' Podés aceptar que el chofer los retire en tu próxima entrega desde la app.'
        : ''),
  };
}

/**
 * Los avisos del recupero de envases (CU-108): al cliente por socket y push, y
 * al administrador por la bandeja. Todo es best-effort: el aviso se registra
 * en `cylinder_recovery_notice` antes de enviarse, así que una entrega que
 * falla no deshace el escalón ni se repite en la corrida siguiente.
 */
@Injectable()
export class CylinderRecoveryNotifier {
  private readonly logger = new Logger(CylinderRecoveryNotifier.name);

  constructor(
    private readonly customers: CustomersGateway,
    private readonly customersService: CustomersService,
    private readonly fcm: FcmPort,
    private readonly events: EventEmitter2,
  ) {}

  /** El aviso en vivo por el socket del cliente (la app lo muestra si está abierta). */
  porSocket(
    caso: CylinderRecoveryCase,
    aviso: CylinderRecoveryNotice,
    ctx: ContextoDelRecupero,
  ): void {
    const { title, body } = textoDelAviso(caso, aviso, ctx);
    void this.seguro('socket', () =>
      this.customers.notifyCustomer(caso.userId, EVENTO_AVISO_DE_RECUPERO, {
        caseId: caso.caseId,
        noticeId: aviso.noticeId,
        kind: aviso.kind,
        step: aviso.step,
        serial: ctx.serial,
        depositAmount: caso.depositAmount,
        expiresAt: aviso.expiresAt.toISOString(),
        orderId: aviso.orderId,
        scheduledDate: ctx.entregaProgramada ?? null,
        title,
        body,
      }),
    );
  }

  /**
   * UN push al cliente con todo lo que le tocó en la corrida: si es un solo
   * aviso, su texto; si son varios (varios envases, o un envase con su oferta
   * de retiro), un resumen. Nunca un push por envase.
   */
  async alClienteAgrupado(
    userId: string,
    avisos: AvisoParaElCliente[],
  ): Promise<void> {
    if (avisos.length === 0) return;
    const { title, body } =
      avisos.length === 1
        ? textoDelAviso(avisos[0].caso, avisos[0].aviso, avisos[0].ctx)
        : textoResumen(avisos);
    const principal = avisos[0];
    await this.seguro('push', async () => {
      const { token } =
        await this.customersService.findNotificationToken(userId);
      if (!token) return;
      await this.fcm.sendToToken(
        token,
        {
          notification: { title, body },
          data: {
            type: 'CYLINDER_RECOVERY',
            kind: principal.aviso.kind,
            caseId: principal.caso.caseId,
            noticeId: principal.aviso.noticeId,
            count: String(avisos.length),
          },
        },
        {
          type: 'CYLINDER_RECOVERY',
          distributorId: principal.caso.distributorId,
          recipientUserId: userId,
        },
      );
    });
  }

  /** La secuencia se agotó y el depósito supera el umbral: el legajo espera al administrador. */
  escaladoAlAdmin(caso: CylinderRecoveryCase, ctx: ContextoDelRecupero): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: caso.distributorId,
      kind: AVISO_RECUPERO_ESCALADO,
      title: 'Envase sin devolver para resolver',
      body: `${ctx.customerName ?? 'Un cliente'} no devolvió el envase ${ctx.serial} (${ctx.diasAfuera} días). Depósito en juego: ${pesos(caso.depositAmount)}. Revisá el legajo y decidí: cobrar el depósito, dar de baja el envase o cerrar sin cargo.`,
      link: { entity: ENTIDAD_CASO_DE_RECUPERO, id: caso.caseId },
      dedupeKey: `cylinder-recovery-escalated:${caso.caseId}`,
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
