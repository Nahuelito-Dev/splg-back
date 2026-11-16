import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENTO_MENSAJE_CREADO,
  type MensajeCreado,
} from '../chat/application/chat.events';
import { auditContext } from '../audit/data/audit-context';
import { errorMessage } from '../common/errors/error-message';
import {
  AsistenteIaService,
  perfilSiCorresponde,
} from './asistente-ia.service';

/**
 * Dispara al asistente con IA cuando llega un mensaje de la otra punta en C3
 * o C1 (después del commit del envío, §4.1.5). No espera la respuesta: el
 * envío del cliente nunca se demora ni falla por el asistente.
 *
 * Corre fuera del contexto de la request que mandó el mensaje
 * (`auditContext.exit`): lo que escribe el asistente lo asienta la auditoría
 * como del sistema, no como del cliente.
 */
@Injectable()
export class AsistenteIaListener {
  private readonly logger = new Logger(AsistenteIaListener.name);

  constructor(private readonly asistente: AsistenteIaService) {}

  @OnEvent(EVENTO_MENSAJE_CREADO)
  alCrearseUnMensaje(evento: MensajeCreado): void {
    if (!perfilSiCorresponde(evento.conversation, evento.message)) return;
    auditContext.exit(() => {
      setImmediate(() => {
        // `then` también atrapa un error síncrono: nunca queda uno sin manejar.
        Promise.resolve()
          .then(() => this.asistente.atender(evento))
          .catch((error: unknown) => {
            this.logger.error(
              `El asistente no pudo atender el mensaje: ${errorMessage(error)}`,
            );
          });
      });
    });
  }
}
