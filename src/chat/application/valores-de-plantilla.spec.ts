import type { EntityManager } from 'typeorm';
import { Channel, ConversationStatus, SubjectType } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { nombreVisibleDeLaEmpresa } from '../infrastructure/nombre-visible-de-la-empresa';
import { ajustesDeLaBandejaPorDefecto } from './company-chat-settings.service';
import { valoresDePlantilla } from './valores-de-plantilla';

describe('valoresDePlantilla', () => {
  it('{{empresa.nombre}} es el nombre de marca (o el legal) y {{cliente.nombre}} el de pila', async () => {
    const query = jest.fn(() =>
      Promise.resolve([{ persona: 'Ana Pérez', empresa: 'Florchi Gas' }]),
    );
    const c = Object.assign(new Conversation(), {
      conversationId: 'conv-1',
      distributorId: 'dist-a',
      channel: Channel.STAFF_CUSTOMER,
      subjectType: SubjectType.GENERAL,
      status: ConversationStatus.OPEN,
      orderId: null,
      customerUserId: 'cli-1',
      driverUserId: null,
    });
    const valores = await valoresDePlantilla(
      { query } as unknown as EntityManager,
      c,
      ajustesDeLaBandejaPorDefecto('dist-a'),
      new Date('2026-11-16T15:00:00Z'),
    );
    expect(valores).toEqual(
      expect.objectContaining({
        'cliente.nombre': 'Ana',
        'empresa.nombre': 'Florchi Gas',
        'pedido.numero': '',
      }),
    );
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain(nombreVisibleDeLaEmpresa('d'));
    expect(sql).toContain('WHERE d."distributor_id" = $2');
    expect(params).toEqual(['cli-1', 'dist-a']);
  });
});
