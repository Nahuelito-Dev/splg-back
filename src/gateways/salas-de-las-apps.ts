import type { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { errorMessage } from '../common/errors/error-message';
import type { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';
import type { SocketDeSplg } from './socket-data';

/**
 * Salas de conversación de las apps (D-C28, bandeja de la empresa): el cliente
 * entra a las suyas con la empresa (C3) y el chofer a las suyas (C2). El
 * servidor valida contra la base que sea parte; el cuerpo sólo trae el id.
 */
export type PuntaDeLaApp = 'customer' | 'driver';

/** Pedido de «escribiendo…» de una app, para que el chat lo reenvíe a la empresa. */
export const EVENTO_ESCRIBIENDO_DE_LA_APP = 'app.escribiendo';

export interface EscribiendoDeLaApp {
  conversationId: string;
  userId: string;
  punta: PuntaDeLaApp;
}

/** Respuesta (ack) de `chat:join` / `chat:leave` en las apps (la misma forma que el panel). */
export type RespuestaDeSalaDeLaApp =
  | { ok: true }
  | { ok: false; code: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ESCRIBIENDO_DE_LA_APP_CADA_MS = 3000;

export function salaDeConversacionDeLaApp(
  conversationId: string,
  punta: PuntaDeLaApp,
): string {
  return `conv:${conversationId}:${punta}`;
}

export function idDeConversacion(cuerpo: unknown): string | null {
  const id =
    typeof cuerpo === 'object' && cuerpo !== null && 'conversationId' in cuerpo
      ? cuerpo.conversationId
      : undefined;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

const DENEGADA: RespuestaDeSalaDeLaApp = {
  ok: false,
  code: 'CHAT_JOIN_DENIED',
  message: 'No existe esa conversación',
};

/**
 * Si esa persona es la parte `punta` de la conversación, sigue siendo de su
 * empresa y la empresa tiene el módulo `chat`. Falla cerrado.
 */
async function esParte(
  participacion: ParticipacionEnConversaciones,
  conversationId: string,
  userId: string,
  punta: PuntaDeLaApp,
  logger: Logger,
): Promise<boolean> {
  try {
    const c = await participacion.deConversacion(conversationId);
    if (!c) return false;
    return (
      (await participacion.personaVigente(conversationId, userId, punta)) &&
      (await participacion.chatHabilitado(c.distributorId))
    );
  } catch (error) {
    logger.warn(
      `No se pudo validar la sala de ${conversationId}: ${errorMessage(error)}`,
    );
    return false;
  }
}

export async function unirseALaConversacion(
  client: SocketDeSplg,
  cuerpo: unknown,
  userId: string,
  punta: PuntaDeLaApp,
  participacion: ParticipacionEnConversaciones | undefined,
  logger: Logger,
): Promise<RespuestaDeSalaDeLaApp> {
  const conversationId = idDeConversacion(cuerpo);
  if (!conversationId) {
    return {
      ok: false,
      code: 'INVALID_ID',
      message: 'El identificador no es válido',
    };
  }
  if (
    !participacion ||
    !(await esParte(participacion, conversationId, userId, punta, logger))
  ) {
    return DENEGADA;
  }
  await client.join(salaDeConversacionDeLaApp(conversationId, punta));
  return { ok: true };
}

export async function salirDeLaConversacion(
  client: SocketDeSplg,
  cuerpo: unknown,
  punta: PuntaDeLaApp,
): Promise<RespuestaDeSalaDeLaApp> {
  const conversationId = idDeConversacion(cuerpo);
  if (!conversationId) return DENEGADA;
  await client.leave(salaDeConversacionDeLaApp(conversationId, punta));
  return { ok: true };
}

/** «Escribiendo…» de una app: uno cada 3 s por conexión y sólo desde una sala en la que entró. */
export function pedirEscribiendo(
  client: SocketDeSplg,
  cuerpo: unknown,
  userId: string,
  punta: PuntaDeLaApp,
  events: EventEmitter2 | undefined,
): void {
  const conversationId = idDeConversacion(cuerpo);
  if (!conversationId || !events) return;
  const ahora = Date.now();
  if (
    ahora - (client.data.ultimoEscribiendo ?? 0) <
    ESCRIBIENDO_DE_LA_APP_CADA_MS
  ) {
    return;
  }
  if (!client.rooms.has(salaDeConversacionDeLaApp(conversationId, punta))) {
    return;
  }
  client.data.ultimoEscribiendo = ahora;
  const pedido: EscribiendoDeLaApp = { conversationId, userId, punta };
  events.emit(EVENTO_ESCRIBIENDO_DE_LA_APP, pedido);
}
