import { EventEmitter2 } from '@nestjs/event-emitter';
import { auditContext } from '../audit/data/audit-context';
import { ChatEvents, Efectos } from '../chat/application/chat.events';
import {
  Channel,
  MessageKind,
  MessageVisibility,
  Party,
} from '../chat/domain/chat.enums';
import type { Conversation } from '../chat/entities/conversation.entity';
import type { Message } from '../chat/entities/message.entity';
import { AsistenteIaListener } from './asistente-ia.listener';
import type { AsistenteIaService } from './asistente-ia.service';

const conversacion = (channel: Channel) =>
  ({
    conversationId: 'conv-1',
    distributorId: 'dist-a',
    channel,
  }) as Conversation;
const mensaje = (senderParty: Party) =>
  ({
    messageId: 'msg-1',
    senderParty,
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: 'Hola',
  }) as Message;

/** Espera a que corra lo programado con `setImmediate`. */
const despuesDelEnvio = () => new Promise((r) => setImmediate(r));

function armar(atender: jest.Mock) {
  const emisor = new EventEmitter2();
  const listener = new AsistenteIaListener({
    atender,
  } as unknown as AsistenteIaService);
  emisor.on(
    'chat.mensaje.creado',
    (e: Parameters<typeof listener.alCrearseUnMensaje>[0]) =>
      listener.alCrearseUnMensaje(e),
  );
  return { eventos: new ChatEvents(emisor) };
}

describe('AsistenteIaListener: el envío del cliente nunca espera ni falla por el asistente', () => {
  it('atiende después del envío, fuera del contexto de la request (la auditoría lo asienta como del sistema)', async () => {
    let contextoAlAtender: unknown = 'sin llamar';
    const atender = jest.fn(() => {
      contextoAlAtender = auditContext.getStore();
      return Promise.resolve();
    });
    const { eventos } = armar(atender);
    auditContext.run(
      { userId: 'cli-1', ip: '1.2.3.4', distributorId: 'dist-a' },
      () => {
        eventos.publicar(
          new Efectos().mensaje(
            conversacion(Channel.STAFF_CUSTOMER),
            mensaje(Party.CUSTOMER),
          ),
        );
      },
    );
    // Todavía no: el envío ya terminó y el asistente arranca después.
    expect(atender).not.toHaveBeenCalled();
    await despuesDelEnvio();
    expect(atender).toHaveBeenCalledTimes(1);
    expect(contextoAlAtender).toBeUndefined();
  });

  it('un asistente que tarda o falla no demora ni rompe la publicación del envío', async () => {
    let terminar: (() => void) | undefined;
    const lento = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          terminar = resolve;
        }),
    );
    const { eventos } = armar(lento);
    expect(() =>
      eventos.publicar(
        new Efectos().mensaje(
          conversacion(Channel.PLATFORM_CHAT),
          mensaje(Party.COMPANY),
        ),
      ),
    ).not.toThrow();
    await despuesDelEnvio();
    expect(lento).toHaveBeenCalledTimes(1);
    terminar?.();

    const fallido = jest.fn(() => Promise.reject(new Error('se cayó todo')));
    const conFalla = armar(fallido);
    expect(() =>
      conFalla.eventos.publicar(
        new Efectos().mensaje(
          conversacion(Channel.STAFF_CUSTOMER),
          mensaje(Party.CUSTOMER),
        ),
      ),
    ).not.toThrow();
    await despuesDelEnvio();
    await despuesDelEnvio();
    expect(fallido).toHaveBeenCalledTimes(1);
  });

  it('ignora lo que no le toca (C2, mensajes del equipo) sin programar nada', async () => {
    const atender = jest.fn(() => Promise.resolve());
    const { eventos } = armar(atender);
    eventos.publicar(
      new Efectos()
        .mensaje(conversacion(Channel.STAFF_DRIVER), mensaje(Party.DRIVER))
        .mensaje(conversacion(Channel.STAFF_CUSTOMER), mensaje(Party.COMPANY)),
    );
    await despuesDelEnvio();
    expect(atender).not.toHaveBeenCalled();
  });
});
