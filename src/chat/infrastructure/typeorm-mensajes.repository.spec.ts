import type { EntityManager } from 'typeorm';
import type { Conversation } from '../entities/conversation.entity';
import { TypeormMensajesRepository } from './typeorm-mensajes.repository';

describe('TypeormMensajesRepository.siguienteSeq', () => {
  const conversacion = {
    conversationId: 'conv-1',
    distributorId: 'dist-a',
  } as Conversation;

  function armar() {
    const query = jest.fn(() => Promise.resolve([[{ seq: '8' }], 1]));
    return { query, manager: { query } as unknown as EntityManager };
  }

  it('un mensaje visible mueve `last_message_at` y `updated_at`; una nota interna (4a) no', async () => {
    const repo = new TypeormMensajesRepository();
    const visible = armar();
    expect(await repo.siguienteSeq(visible.manager, conversacion, 'Hola')).toBe(
      8,
    );
    const nota = armar();
    await repo.siguienteSeq(nota.manager, conversacion, null, false);
    const [sql, params] = visible.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain(
      '"last_message_at" = CASE WHEN $4 THEN now() ELSE "last_message_at" END',
    );
    // Tampoco `updated_at`: el `updatedSince` y el `updatedAt` del cliente no la delatan.
    expect(sql).toContain(
      '"updated_at" = CASE WHEN $4 THEN now() ELSE "updated_at" END',
    );
    expect(params).toEqual(['conv-1', 'dist-a', 'Hola', true]);
    expect(
      (nota.query.mock.calls[0] as unknown as [string, unknown[]])[1],
    ).toEqual(['conv-1', 'dist-a', null, false]);
  });
});
