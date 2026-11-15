import type { DataSource } from 'typeorm';
import type { RedisService } from '../../redis/redis.service';
import { TicketStatus } from '../domain/chat.enums';
import type { SupportTicket } from '../entities/support-ticket.entity';
import type { ChatNotices } from './chat-notices';
import type { PlatformChatService } from './platform-chat.service';
import { SupportHousekeepingCron } from './support-housekeeping.cron';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from './support-settings.service';
import type { TicketActivityService } from './ticket-activity.service';

const AHORA = new Date('2026-11-14T12:00:00Z');
const haceDias = (n: number) => new Date(AHORA.getTime() - n * 86_400_000);

const t = (id: string, status: TicketStatus, dias: number) =>
  ({
    ticketId: id,
    distributorId: 'dist-a',
    status,
    statusChangedAt: haceDias(dias),
  }) as SupportTicket;

describe('SupportHousekeepingCron (reloj fijo)', () => {
  it('cierra a los 7 días, avisa a los 5, deja lo demás y avisa los objetivos vencidos', async () => {
    const enEspera = [
      t('espera-7', TicketStatus.WAITING_COMPANY, 7.1),
      t('espera-5', TicketStatus.WAITING_COMPANY, 5.2),
      t('espera-2', TicketStatus.WAITING_COMPANY, 2),
      t('resuelto-8', TicketStatus.RESOLVED, 8),
      t('resuelto-6', TicketStatus.RESOLVED, 6),
    ];
    const vencido = t('nuevo-vencido', TicketStatus.NEW, 1);
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      getMany: () => Promise.resolve([vencido]),
    };
    const ds = {
      getRepository: () => ({
        find: () => Promise.resolve(enEspera),
        createQueryBuilder: () => qb,
      }),
      manager: { query: () => Promise.resolve([{ name: 'Gas Norte' }]) },
    } as unknown as DataSource;
    const tickets = {
      cerrarVencido: jest.fn(
        (_id: string, sigue: (x: SupportTicket) => boolean) =>
          Promise.resolve(sigue(enEspera.find((x) => x.ticketId === _id)!)),
      ),
    };
    const chats = { cerrarInactivos: jest.fn().mockResolvedValue(2) };
    const avisos = { porCerrarse: jest.fn(), sinPrimeraRespuesta: jest.fn() };
    const cron = new SupportHousekeepingCron(
      ds,
      {} as RedisService,
      {
        leer: () => Promise.resolve(configuracionPorDefecto()),
      } as unknown as SupportSettingsService,
      chats as unknown as PlatformChatService,
      tickets as unknown as TicketActivityService,
      avisos as unknown as ChatNotices,
    );

    const r = await cron.barrer(AHORA);

    expect(r).toEqual({
      chatsClosed: 2,
      ticketsClosed: 2,
      warned: 1,
      overdue: 1,
    });
    expect(chats.cerrarInactivos).toHaveBeenCalledWith(AHORA, 24);
    expect(tickets.cerrarVencido.mock.calls.map(([id]) => id)).toEqual([
      'espera-7',
      'resuelto-8',
    ]);
    expect(avisos.porCerrarse).toHaveBeenCalledWith(enEspera[1], 2);
    expect(avisos.sinPrimeraRespuesta).toHaveBeenCalledWith(
      vencido,
      'Gas Norte',
    );
  });
});
