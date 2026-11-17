import type { EntityManager } from 'typeorm';
import { Channel, ConversationStatus, Party } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import type { AdjuntosDelChat } from './adjuntos-del-chat.service';
import type { ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import { BandejaAdjuntos } from './bandeja-adjuntos.service';
import { Efectos } from './chat.events';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import type { ConversacionVigente } from './conversacion-vigente';
import type { MessageWriter } from './message-writer';
import type { SendAttachmentDto } from '../presentation/dto/chat-attachment.dto';

const D = 'dist-a';
const ESPERA = 'SET "awaiting_human_since" = $2';

const actor = (party: ActorDeLaBandeja['party']): ActorDeLaBandeja => ({
  party,
  userId: party === Party.COMPANY ? 'adm-1' : 'cli-1',
  distributorId: D,
  canales: [Channel.STAFF_CUSTOMER],
  permisos: [],
});

/** Un adjunto: el doble de `AdjuntosDelChat.subir` corre el paso de escribir con una transacción falsa. */
function armar(
  autoAssignEnabled: boolean,
  cambios: Partial<Conversation> = {},
) {
  const c = Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: D,
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.OPEN,
    assignedToUserId: null,
    awaitingHumanSince: null,
    ...cambios,
  });
  const consultas: Array<[string, unknown[]]> = [];
  const manager = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      consultas.push([sql, params]);
      // Los ajustes, leídos con `FOR SHARE` en la transacción del adjunto.
      return Promise.resolve(
        sql.includes('FOR SHARE')
          ? [{ auto_assign_enabled: autoAssignEnabled }]
          : [],
      );
    }),
  } as unknown as EntityManager;
  const efectos = new Efectos();
  const adjuntos = {
    subir: jest.fn(
      async (
        _pedido: unknown,
        escribir: (
          m: EntityManager,
          nuevo: unknown,
          e: Efectos,
        ) => Promise<unknown>,
      ) => escribir(manager, {}, efectos),
    ),
  };
  const writer = {
    escribir: jest.fn(() =>
      Promise.resolve({
        created: true,
        conversation: c,
        message: { seq: 5, messageId: 'm-5' },
      }),
    ),
  };
  const ajustes = {
    leer: jest.fn(() =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto(D), { autoAssignEnabled }),
      ),
    ),
  };
  const servicio = new BandejaAdjuntos(
    { buscar: jest.fn(() => Promise.resolve(c)) } as unknown as BandejaAcceso,
    {
      assertSePuedeEscribir: jest.fn(() => Promise.resolve()),
    } as unknown as ConversacionVigente,
    ajustes as unknown as CompanyChatSettingsService,
    writer as unknown as MessageWriter,
    adjuntos as unknown as AdjuntosDelChat,
  );
  const espera = () => consultas.find(([q]) => q.includes(ESPERA));
  return { servicio, espera, efectos, c };
}

const enviar = (
  m: ReturnType<typeof armar>,
  party: ActorDeLaBandeja['party'],
) =>
  m.servicio.enviar(
    actor(party),
    'conv-1',
    undefined,
    {} as unknown as SendAttachmentDto,
  );

describe('BandejaAdjuntos: un adjunto del cliente o del chofer también deja esperando a una persona (8b)', () => {
  it('con la función prendida y sin asignar: espera, con motivo `auto_assign`, y avisa el cambio', async () => {
    for (const party of [Party.CUSTOMER, Party.DRIVER] as const) {
      const m = armar(true);
      await enviar(m, party);
      expect(m.espera()?.[1]).toEqual([
        'conv-1',
        expect.any(Date),
        'auto_assign',
      ]);
      expect(m.efectos.conversaciones.map((x) => x.change)).toContain('status');
    }
  });

  it('apagada, asignada o ya esperando: nada', async () => {
    for (const m of [
      armar(false),
      armar(true, { assignedToUserId: 'adm-1' }),
      armar(true, { awaitingHumanSince: new Date() }),
    ]) {
      await enviar(m, Party.CUSTOMER);
      expect(m.espera()).toBeUndefined();
    }
  });

  it('el adjunto del equipo no la deja esperando', async () => {
    const m = armar(true);
    await enviar(m, Party.COMPANY);
    expect(m.espera()).toBeUndefined();
  });
});
