import type { ChatReadModel } from '../infrastructure/chat-read-model';
import { SupportSummaryService } from './support-summary.service';

describe('SupportSummaryService (relevamiento B3)', () => {
  it('la insignia de la empresa suma los mensajes del chat y los tickets con novedades', async () => {
    const s = new SupportSummaryService({
      resumenDeLaEmpresa: () =>
        Promise.resolve({ chatUnread: 3, ticketsUnread: 2 }),
    } as unknown as ChatReadModel);
    await expect(s.deLaEmpresa('dist-a', 'a')).resolves.toEqual({
      chatUnread: 3,
      ticketsUnread: 2,
      total: 5,
    });
  });

  it('la de la plataforma suma chats y tickets sin leer (los sin asignar van aparte)', async () => {
    const s = new SupportSummaryService({
      resumenDeLaPlataforma: () =>
        Promise.resolve({
          chatsUnread: 1,
          chatsUnassigned: 4,
          ticketsUnread: 5,
          ticketsUnassigned: 7,
        }),
    } as unknown as ChatReadModel);
    await expect(s.deLaPlataforma('s')).resolves.toEqual({
      chatsUnread: 1,
      chatsUnassigned: 4,
      ticketsUnread: 5,
      ticketsUnassigned: 7,
      total: 6,
    });
  });
});
