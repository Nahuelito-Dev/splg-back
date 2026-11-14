import type { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { errorMessage } from '../errors/error-message';
import {
  DestinoDelAviso,
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from './notificar-admin.event';

/** Id corto de un pedido para los textos de los avisos: los últimos 6 del uuid, en mayúscula (como `formatShortId` del panel). */
export function idCortoDePedido(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

interface AvisoAlAdmin {
  /** `null`: aviso de la plataforma, no de una empresa. */
  distributorId: string | null;
  kind: string;
  title: string;
  body: string;
  link: DestinoDelAviso | null;
  dedupeKey: string;
  email?: boolean;
}

/**
 * Pide un aviso para los administradores de la distribuidora. Best-effort: el
 * hecho que se avisa ya ocurrió, así que si emitir falla no se propaga.
 * Se registra en el log de quien emite.
 */
export function pedirAvisoAlAdmin(
  events: EventEmitter2,
  logger: Logger,
  aviso: AvisoAlAdmin,
): void {
  try {
    events.emit(
      EVENTO_NOTIFICAR_ADMIN,
      new NotificarAdminEvent(
        aviso.distributorId,
        aviso.kind,
        aviso.title,
        aviso.body,
        aviso.link,
        aviso.email ?? false,
        aviso.dedupeKey,
      ),
    );
  } catch (error) {
    logger.warn(
      `No se pudo pedir el aviso ${aviso.kind} (${aviso.dedupeKey}): ${errorMessage(error)}`,
    );
  }
}
