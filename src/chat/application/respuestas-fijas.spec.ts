import type { EntityManager } from 'typeorm';
import { Channel } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { Efectos } from './chat.events';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import type { ChatViewsService } from './chat-views.service';
import type { MessageWriter } from './message-writer';
import { RespuestasFijas } from './respuestas-fijas';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from './support-settings.service';

/**
 * Las notas internas (4a) no cuentan como que alguien del equipo escribió:
 * si el personal sólo dejó una nota, al cliente todavía le corresponde el
 * aviso de recibido (y a la empresa en C1, el de la plataforma).
 */
describe('RespuestasFijas: las notas internas no cuentan (4a)', () => {
  function armar() {
    const consultas: string[] = [];
    const manager = {
      query: jest.fn((sql: string) => {
        consultas.push(sql.replace(/\s+/g, ' '));
        return Promise.resolve([
          { fuera: false, recibido: false, empresa: false, plataforma: false },
        ]);
      }),
    } as unknown as EntityManager;
    const escribir = jest.fn(() =>
      Promise.resolve({
        message: {},
        created: true,
        conversation: new Conversation(),
      }),
    );
    const fijas = new RespuestasFijas(
      { escribir } as unknown as MessageWriter,
      {
        leer: jest.fn(() =>
          Promise.resolve({
            ...ajustesDeLaBandejaPorDefecto('dist-a'),
            ackEnabled: true,
          }),
        ),
      } as unknown as CompanyChatSettingsService,
      {
        leer: jest.fn(() => Promise.resolve(configuracionPorDefecto())),
      } as unknown as SupportSettingsService,
      { nombreDeLaPlataforma: () => 'OrixTech' } as unknown as ChatViewsService,
    );
    return { fijas, manager, consultas, escribir };
  }

  const c = Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: 'dist-a',
    channel: Channel.STAFF_CUSTOMER,
  });

  it('C3: «la empresa ya escribió» mira sólo lo visible', async () => {
    const t = armar();
    await t.fijas.deLaEmpresa(t.manager, c, new Efectos(), new Date());
    expect(t.consultas[0]).toContain(
      `"sender_party" = 'company' AND "visibility" = 'all') AS empresa`,
    );
  });

  it('C1: «la plataforma ya escribió» y el último de la plataforma miran sólo lo visible', async () => {
    const t = armar();
    await t.fijas.delSoporte(
      t.manager,
      { ...c, channel: Channel.PLATFORM_CHAT } as Conversation,
      new Efectos(),
      new Date(),
    );
    expect(t.consultas[0]).toContain(
      `"sender_party" = 'platform' AND "visibility" = 'all') AS plataforma`,
    );
    expect(t.consultas[0]).toContain(
      `p."sender_party" = 'platform' AND p."visibility" = 'all'`,
    );
  });
});
