import type { DataSource, EntityManager } from 'typeorm';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  SubjectType,
  SystemCode,
} from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import type { ChatEvents, Efectos } from './chat.events';
import { ConversacionVigente } from './conversacion-vigente';
import type { MessageWriter } from './message-writer';

function c2(cambios: Partial<Conversation> = {}): Conversation {
  return Object.assign(new Conversation(), {
    conversationId: 'conv-d1',
    distributorId: 'dist-a',
    channel: Channel.STAFF_DRIVER,
    subjectType: SubjectType.ORDER,
    status: ConversationStatus.OPEN,
    orderId: 'p-1',
    customerUserId: null,
    driverUserId: 'cho-1',
    ...cambios,
  });
}

/**
 * La base, en lo que importa: quién lleva hoy el pedido, si la persona sigue
 * siendo de la empresa y las C2 abiertas del pedido.
 */
function armar(base: {
  choferActual: string | null;
  personaDeLaEmpresa?: boolean;
  abiertasDeOtros?: string[];
}) {
  const conversacionesGuardadas: Conversation[] = [];
  const consultas: string[] = [];
  const query = jest.fn((sql: string) => {
    consultas.push(sql);
    if (sql.includes('AS chofer')) {
      return Promise.resolve([{ chofer: base.choferActual }]);
    }
    if (sql.includes('IS DISTINCT FROM d."user_id"')) {
      return Promise.resolve(
        (base.abiertasDeOtros ?? []).map((id) => ({ conversation_id: id })),
      );
    }
    // clienteDeLaEmpresa / choferDeLaEmpresa
    return Promise.resolve(base.personaDeLaEmpresa === false ? [] : [{}]);
  });
  const repo = {
    findOne: jest.fn(({ where }: { where: { conversationId: string } }) =>
      Promise.resolve(c2({ conversationId: where.conversationId })),
    ),
    findOneByOrFail: jest.fn(({ conversationId }: { conversationId: string }) =>
      Promise.resolve(c2({ conversationId })),
    ),
    save: jest.fn((c: Conversation) => {
      conversacionesGuardadas.push(c);
      return Promise.resolve(c);
    }),
  };
  const manager = {
    query,
    getRepository: () => repo,
  } as unknown as EntityManager;
  const dataSource = {
    manager,
    query,
    transaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
      fn(manager),
    ),
  } as unknown as DataSource;
  const escribir = jest.fn(
    (_m: EntityManager, nuevo: { conversationId: string }) =>
      Promise.resolve({
        created: true,
        message: { seq: 3 },
        conversation: c2({ conversationId: nuevo.conversationId }),
      }),
  );
  const publicados: Efectos[] = [];
  const vigente = new ConversacionVigente(
    dataSource,
    { escribir } as unknown as MessageWriter,
    { publicar: (e: Efectos) => publicados.push(e) } as unknown as ChatEvents,
  );
  return { vigente, conversacionesGuardadas, escribir, publicados };
}

describe('ConversacionVigente (Corrección 1 de CH3)', () => {
  it('C2 por pedido reasignado: al escribir, la del chofer anterior se cierra (driver_changed) y da 409', async () => {
    const { vigente, conversacionesGuardadas, escribir, publicados } = armar({
      choferActual: 'cho-2',
    });
    await expect(vigente.assertSePuedeEscribir(c2())).rejects.toMatchObject({
      code: 'CONVERSATION_CLOSED',
    });
    expect(escribir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemCode: SystemCode.DRIVER_CHANGED }),
    );
    expect(conversacionesGuardadas[0]).toMatchObject({
      status: ConversationStatus.CLOSED,
      closedReason: ConversationClosedReason.DRIVER_CHANGED,
    });
    expect(publicados[0].conversaciones[0].change).toBe('closed');
  });

  it('si el pedido volvió a buscar chofer, la del anterior también se cierra', async () => {
    const { vigente } = armar({ choferActual: null });
    await expect(vigente.assertSePuedeEscribir(c2())).rejects.toMatchObject({
      code: 'CONVERSATION_CLOSED',
    });
  });

  it('el chofer actual del pedido escribe; en una general no se mira el pedido', async () => {
    const { vigente, escribir } = armar({ choferActual: 'cho-1' });
    await expect(vigente.assertSePuedeEscribir(c2())).resolves.toBeUndefined();
    await expect(
      vigente.assertSePuedeEscribir(
        c2({ subjectType: SubjectType.GENERAL, orderId: null }),
      ),
    ).resolves.toBeUndefined();
    expect(escribir).not.toHaveBeenCalled();
  });

  it('la persona que ya no es de la empresa → 409 CHAT_NOT_WRITABLE (sin cerrar)', async () => {
    const { vigente, escribir } = armar({
      choferActual: 'cho-1',
      personaDeLaEmpresa: false,
    });
    await expect(vigente.assertSePuedeEscribir(c2())).rejects.toMatchObject({
      code: 'CHAT_NOT_WRITABLE',
    });
    await expect(
      vigente.assertSePuedeEscribir(
        c2({
          channel: Channel.STAFF_CUSTOMER,
          subjectType: SubjectType.GENERAL,
          orderId: null,
          customerUserId: 'cli-1',
          driverUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_WRITABLE' });
    expect(escribir).not.toHaveBeenCalled();
  });

  it('al reasignar el pedido (evento), cierra las C2 abiertas de los choferes que ya no lo llevan', async () => {
    const { vigente, conversacionesGuardadas } = armar({
      choferActual: 'cho-2',
      abiertasDeOtros: ['conv-d1'],
    });
    await vigente.alCambiarElChofer({
      orderId: 'p-1',
      distributorId: 'dist-a',
      anterior: 'cho-1',
      nuevo: 'cho-2',
    });
    expect(conversacionesGuardadas.map((c) => c.conversationId)).toEqual([
      'conv-d1',
    ]);
  });
});
