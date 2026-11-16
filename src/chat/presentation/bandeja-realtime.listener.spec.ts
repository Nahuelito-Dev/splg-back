import type { DataSource } from 'typeorm';
import type { AdminGateway } from '../../gateways/admin.gateway';
import type { CustomersGateway } from '../../gateways/customers.gateway';
import type { DriversGateway } from '../../gateways/drivers.gateway';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
} from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { BandejaRealtimeListener } from './bandeja-realtime.listener';
import type { BandejaPresenter } from './bandeja.presenter';
import { ChatRealtimeListener } from './chat-realtime.listener';
import type { ChatViewsService } from '../application/chat-views.service';

const c3 = Object.assign(new Conversation(), {
  conversationId: 'conv-1',
  distributorId: 'dist-a',
  channel: Channel.STAFF_CUSTOMER,
  subjectType: SubjectType.GENERAL,
  status: ConversationStatus.OPEN,
  customerUserId: 'cli-1',
  driverUserId: null,
  assignedToUserId: null,
  lastMessageSeq: 2,
});
const c2 = Object.assign(new Conversation(), {
  ...c3,
  conversationId: 'conv-2',
  channel: Channel.STAFF_DRIVER,
  customerUserId: null,
  driverUserId: 'cho-1',
});
const m = Object.assign(new Message(), {
  messageId: 'm-2',
  conversationId: 'conv-1',
  distributorId: 'dist-a',
  seq: 2,
  senderParty: Party.COMPANY,
  senderUserId: 'adm-1',
  kind: MessageKind.TEXT,
  visibility: MessageVisibility.ALL,
  body: 'Hola Ana',
  redactedAt: null,
  withdrawnAt: null,
  createdAt: new Date('2026-11-16T12:00:00Z'),
});

function armar(
  conversacionDeLaBase: Conversation | null = c3,
  /** El último `seq` visible hasta lo leído; sin él, lo leído (no hay notas). */
  visibleHasta?: number,
) {
  const panel = {
    emitirAConversacion: jest.fn(),
    emitirALaBandeja: jest.fn(),
    emitirAUsuario: jest.fn(),
    emitirAlSoporteDeEmpresa: jest.fn(),
    emitirAlSoporteDePlataforma: jest.fn(),
  };
  const clientes = {
    emitirAConversacion: jest.fn(),
    emitirAUsuario: jest.fn(),
  };
  const choferes = {
    emitirAConversacion: jest.fn(),
    emitirAUsuario: jest.fn(),
  };
  const presentar = {
    mensaje: jest.fn((msg: Message, quien: { party: Party }) =>
      Promise.resolve({ seq: msg.seq, para: quien.party }),
    ),
    conversacion: jest.fn((_c: Conversation, quien: { party: Party }) =>
      Promise.resolve({ para: quien.party }),
    ),
  };
  const dataSource = {
    getRepository: () => ({
      findOne: jest.fn().mockResolvedValue(conversacionDeLaBase),
    }),
    query: jest.fn((_sql: string, [, seq]: [string, number]) =>
      Promise.resolve([{ seq: visibleHasta ?? seq }]),
    ),
  } as unknown as DataSource;
  const listener = new BandejaRealtimeListener(
    panel as unknown as AdminGateway,
    clientes as unknown as CustomersGateway,
    choferes as unknown as DriversGateway,
    presentar as unknown as BandejaPresenter,
    dataSource,
  );
  return { listener, panel, clientes, choferes };
}

describe('BandejaRealtimeListener (D-C28, D-C10, D-C5)', () => {
  describe('notas internas (4a): sólo al panel', () => {
    it('el «leído» del personal hasta una nota: la persona ve el último visible antes; las pestañas del admin, lo que leyó', async () => {
      const { listener, panel, clientes } = armar(c3, 4);
      await listener.lectura({
        conversationId: 'conv-1',
        distributorId: 'dist-a',
        channel: Channel.STAFF_CUSTOMER,
        party: Party.COMPANY,
        lastReadSeq: 5,
        userId: 'adm-1',
        personal: true,
        deLaParte: true,
      });
      expect(clientes.emitirAConversacion).toHaveBeenCalledWith(
        'conv-1',
        'chat:read',
        { conversationId: 'conv-1', party: Party.COMPANY, lastReadSeq: 4 },
      );
      expect(panel.emitirAUsuario).toHaveBeenCalledWith('adm-1', 'chat:read', {
        conversationId: 'conv-1',
        party: Party.COMPANY,
        lastReadSeq: 5,
      });
    });

    const nota = Object.assign(new Message(), {
      ...m,
      visibility: MessageVisibility.INTERNAL,
      body: '@Juan fijate',
    });

    it.each([
      ['C3', c3],
      ['C2', c2],
    ])(
      '%s: la nota va a la sala del panel y a su lista; a la persona, nada',
      async (_caso, conversacion) => {
        const { listener, panel, clientes, choferes } = armar(conversacion);
        await listener.mensaje({
          conversation: conversacion,
          message: Object.assign(new Message(), {
            ...nota,
            conversationId: conversacion.conversationId,
          }),
        });
        expect(panel.emitirAConversacion).toHaveBeenCalledWith(
          conversacion.conversationId,
          'company',
          'chat:message',
          expect.objectContaining({ message: { seq: 2, para: Party.COMPANY } }),
        );
        expect(panel.emitirALaBandeja).toHaveBeenCalledWith(
          'dist-a',
          conversacion.channel,
          'chat:inbox',
          expect.objectContaining({
            lastMessage: expect.objectContaining({
              internal: true,
              preview: null,
            }) as unknown,
          }),
        );
        for (const gw of [clientes, choferes]) {
          expect(gw.emitirAConversacion).not.toHaveBeenCalled();
          expect(gw.emitirAUsuario).not.toHaveBeenCalled();
        }
      },
    );

    it('editar una nota (la última): sólo al panel', async () => {
      const { listener, panel, clientes } = armar();
      await listener.edicion({ conversation: c3, message: nota });
      expect(panel.emitirAConversacion).toHaveBeenCalledWith(
        'conv-1',
        'company',
        'chat:message-edited',
        expect.anything(),
      );
      expect(clientes.emitirAConversacion).not.toHaveBeenCalled();
      expect(clientes.emitirAUsuario).not.toHaveBeenCalled();
    });

    it('un mensaje visible sigue llegando a la persona (el aviso de la lista dice que no es interno)', async () => {
      const { listener, panel, clientes } = armar();
      await listener.mensaje({ conversation: c3, message: m });
      expect(clientes.emitirAConversacion).toHaveBeenCalled();
      expect(panel.emitirALaBandeja).toHaveBeenCalledWith(
        'dist-a',
        Channel.STAFF_CUSTOMER,
        'chat:inbox',
        expect.objectContaining({
          lastMessage: expect.objectContaining({ internal: false }) as unknown,
        }),
      );
    });
  });

  it('mensaje de C3: cada punta su versión en la sala; a la lista del panel con vista previa; al cliente sólo el puntero', async () => {
    const { listener, panel, clientes, choferes } = armar();
    await listener.mensaje({ conversation: c3, message: m });
    expect(panel.emitirAConversacion).toHaveBeenCalledWith(
      'conv-1',
      'company',
      'chat:message',
      expect.objectContaining({ message: { seq: 2, para: Party.COMPANY } }),
    );
    // D-C10 (§7.2): a la sala del cliente, sólo el puntero, sin el mensaje.
    expect(clientes.emitirAConversacion).toHaveBeenCalledWith(
      'conv-1',
      'chat:message',
      { conversationId: 'conv-1', distributorId: 'dist-a', seq: 2 },
    );
    expect(panel.emitirALaBandeja).toHaveBeenCalledWith(
      'dist-a',
      Channel.STAFF_CUSTOMER,
      'chat:inbox',
      expect.objectContaining({
        lastMessage: expect.objectContaining({
          preview: 'Hola Ana',
        }) as unknown,
      }),
    );
    const [, , puntero] = clientes.emitirAUsuario.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(clientes.emitirAUsuario).toHaveBeenCalledWith(
      'cli-1',
      'chat:inbox',
      expect.anything(),
    );
    expect(puntero).not.toHaveProperty('lastMessage');
    expect(JSON.stringify(puntero)).not.toContain('Hola Ana');
    // Nada a la sala de soporte (C1) ni a los choferes.
    expect(panel.emitirAlSoporteDeEmpresa).not.toHaveBeenCalled();
    expect(panel.emitirAlSoporteDePlataforma).not.toHaveBeenCalled();
    expect(choferes.emitirAConversacion).not.toHaveBeenCalled();
  });

  it('mensaje de C2: a la lista de choferes y al chofer', async () => {
    const { listener, panel, choferes, clientes } = armar(c2);
    await listener.mensaje({
      conversation: c2,
      message: Object.assign(new Message(), { ...m, conversationId: 'conv-2' }),
    });
    expect(panel.emitirALaBandeja).toHaveBeenCalledWith(
      'dist-a',
      Channel.STAFF_DRIVER,
      'chat:inbox',
      expect.anything(),
    );
    // Al chofer (de una sola empresa), el mensaje completo.
    expect(choferes.emitirAConversacion).toHaveBeenCalledWith(
      'conv-2',
      'chat:message',
      expect.objectContaining({ message: { seq: 2, para: Party.DRIVER } }),
    );
    expect(choferes.emitirAUsuario).toHaveBeenCalledWith(
      'cho-1',
      'chat:inbox',
      expect.anything(),
    );
    expect(clientes.emitirAConversacion).not.toHaveBeenCalled();
  });

  it('el listener de C1 no toca la bandeja (y éste no toca C1)', async () => {
    const gateway = {
      emitirAConversacion: jest.fn(),
      emitirAlSoporteDeEmpresa: jest.fn(),
      emitirAlSoporteDePlataforma: jest.fn(),
    };
    const c1 = new ChatRealtimeListener(
      gateway as unknown as AdminGateway,
      {} as unknown as ChatViewsService,
      {} as unknown as DataSource,
    );
    await c1.mensaje({ conversation: c3, message: m });
    expect(gateway.emitirAConversacion).not.toHaveBeenCalled();
    const { listener, panel } = armar();
    await listener.mensaje({
      conversation: Object.assign(new Conversation(), {
        ...c3,
        channel: Channel.PLATFORM_CHAT,
      }),
      message: m,
    });
    expect(panel.emitirAConversacion).not.toHaveBeenCalled();
  });

  it('edición y borrado: a las dos salas con su evento', async () => {
    const { listener, panel, clientes } = armar();
    await listener.edicion({ conversation: c3, message: m });
    await listener.borrado({ conversation: c3, message: m });
    const eventos = (llamadas: unknown[][], i: number) =>
      llamadas.map((c) => c[i]);
    expect(
      eventos(panel.emitirAConversacion.mock.calls as unknown[][], 2),
    ).toEqual(['chat:message-edited', 'chat:message-deleted']);
    expect(
      eventos(clientes.emitirAConversacion.mock.calls as unknown[][], 1),
    ).toEqual(['chat:message-edited', 'chat:message-deleted']);
  });

  it('«leído» de la empresa: al cliente en su sala y a las otras pestañas del admin', async () => {
    const { listener, panel, clientes } = armar();
    await listener.lectura({
      conversationId: 'conv-1',
      distributorId: 'dist-a',
      channel: Channel.STAFF_CUSTOMER,
      party: Party.COMPANY,
      lastReadSeq: 2,
      userId: 'adm-1',
      personal: true,
      deLaParte: true,
    });
    expect(panel.emitirAUsuario).toHaveBeenCalledWith(
      'adm-1',
      'chat:read',
      expect.anything(),
    );
    expect(clientes.emitirAConversacion).toHaveBeenCalledWith(
      'conv-1',
      'chat:read',
      { conversationId: 'conv-1', party: Party.COMPANY, lastReadSeq: 2 },
    );
  });

  it('«escribiendo…»: del panel al cliente sin decir quién; de otra empresa, nada', async () => {
    const { listener, clientes } = armar();
    await listener.escribiendoDelPanel({
      conversationId: 'conv-1',
      userId: 'adm-1',
      distributorId: 'dist-a',
      esPlataforma: false,
      internal: false,
    });
    const [, , carga] = clientes.emitirAConversacion.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(carga).sort()).toEqual([
      'conversationId',
      'party',
      'until',
    ]);
    const otra = armar();
    await otra.listener.escribiendoDelPanel({
      conversationId: 'conv-1',
      userId: 'adm-b',
      distributorId: 'dist-b',
      esPlataforma: false,
      internal: false,
    });
    expect(otra.clientes.emitirAConversacion).not.toHaveBeenCalled();
  });

  it('«escribiendo…» de una nota interna (4a): a la persona no le llega', async () => {
    const { listener, clientes, choferes } = armar();
    await listener.escribiendoDelPanel({
      conversationId: 'conv-1',
      userId: 'adm-1',
      distributorId: 'dist-a',
      esPlataforma: false,
      internal: true,
    });
    expect(clientes.emitirAConversacion).not.toHaveBeenCalled();
    expect(choferes.emitirAConversacion).not.toHaveBeenCalled();
  });

  it('«escribiendo…» de la app: sólo si la conversación es de quien escribe', async () => {
    const { listener, panel } = armar();
    await listener.escribiendoDeLaApp({
      conversationId: 'conv-1',
      userId: 'otro-cliente',
      punta: 'customer',
    });
    expect(panel.emitirAConversacion).not.toHaveBeenCalled();
    await listener.escribiendoDeLaApp({
      conversationId: 'conv-1',
      userId: 'cli-1',
      punta: 'customer',
    });
    expect(panel.emitirAConversacion).toHaveBeenCalledWith(
      'conv-1',
      'company',
      'chat:typing',
      expect.objectContaining({ party: Party.CUSTOMER }),
    );
  });
});
