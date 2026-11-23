import type { ConfigService } from '@nestjs/config';
import { ChatViewsService } from '../application/chat-views.service';
import { TicketPriority, TicketStatus } from '../domain/chat.enums';
import type { SupportTicket } from '../entities/support-ticket.entity';
import type { ChatReadModel } from '../infrastructure/chat-read-model';
import type { EntityPhotoService } from '../../s3/entity-photo.service';
import { ChatPresenter, comoEmpresa, comoPlataforma } from './chat.presenter';

const ticket = (ticketId: string, distributorId: string): SupportTicket =>
  ({
    ticketId,
    distributorId,
    conversationId: `hilo-${ticketId}`,
    number: 12,
    subject: 'Factura duplicada',
    status: TicketStatus.WAITING_COMPANY,
    priority: TicketPriority.NORMAL,
    updatedAt: new Date('2026-11-14T10:00:00Z'),
    createdAt: new Date('2026-11-14T09:00:00Z'),
    firstResponseDueAt: null,
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    assignedMemberUserId: null,
    originConversationId: null,
  }) as unknown as SupportTicket;

function armar() {
  const vacio = () => Promise.resolve(new Map());
  const logosDeLasEmpresas = jest.fn((ids: Iterable<string>) =>
    Promise.resolve(
      new Map(
        [...new Set(ids)]
          .filter((id) => id === 'dist-a')
          .map((id) => [id, `distributors/${id}/logo/x.png`]),
      ),
    ),
  );
  const lectura = {
    noLeidos: vacio,
    ultimosVisibles: vacio,
    lecturaDeLaOtraParte: vacio,
    lecturaPropia: vacio,
    citadosEn: vacio,
    ticketsDesde: vacio,
    ticketsDeLosHilos: vacio,
    adjuntos: vacio,
    nombres: vacio,
    empresas: () =>
      Promise.resolve(
        new Map([
          ['dist-a', 'Gas Norte'],
          ['dist-b', 'Gas Sur'],
        ]),
      ),
    sesionesDeSoporte: vacio,
    logosDeLasEmpresas,
  } as unknown as ChatReadModel;
  const urlDe = jest.fn((key: string | null | undefined) =>
    Promise.resolve(key ? `https://s3.test/${key}?firma` : null),
  );
  const presentar = new ChatPresenter(
    new ChatViewsService(lectura, {
      get: () => undefined,
    } as unknown as ConfigService),
    lectura,
    { urlDe } as unknown as EntityPhotoService,
  );
  return { presentar, logosDeLasEmpresas, urlDe };
}

describe('ChatPresenter: el logo de la empresa en los tickets de la plataforma', () => {
  it('la plataforma recibe el logo firmado de la empresa de cada ticket; la que no tiene, null', async () => {
    const { presentar } = armar();
    const dtos = await presentar.tickets(
      [ticket('t1', 'dist-a'), ticket('t2', 'dist-b')],
      comoPlataforma('s'),
    );
    expect(dtos.map((d) => [d.distributorName, d.distributorLogoUrl])).toEqual([
      ['Gas Norte', 'https://s3.test/distributors/dist-a/logo/x.png?firma'],
      ['Gas Sur', null],
    ]);
  });

  it('una sola consulta por los ids y una firma por empresa, aunque haya varios tickets de la misma (sin N+1)', async () => {
    const { presentar, logosDeLasEmpresas, urlDe } = armar();
    await presentar.tickets(
      [ticket('t1', 'dist-a'), ticket('t2', 'dist-a'), ticket('t3', 'dist-b')],
      comoPlataforma('s'),
    );
    expect(logosDeLasEmpresas).toHaveBeenCalledTimes(1);
    expect(urlDe).toHaveBeenCalledTimes(1);
  });

  it('la ficha de un ticket (plataforma) también lo trae', async () => {
    const { presentar } = armar();
    const dto = await presentar.ticket(
      ticket('t1', 'dist-a'),
      comoPlataforma('s'),
    );
    expect(dto.distributorLogoUrl).toBe(
      'https://s3.test/distributors/dist-a/logo/x.png?firma',
    );
  });

  it('a la empresa no se le firma ni se le consulta nada: `distributorLogoUrl` es null', async () => {
    const { presentar, logosDeLasEmpresas, urlDe } = armar();
    const [dto] = await presentar.tickets(
      [ticket('t1', 'dist-a')],
      comoEmpresa('a'),
    );
    expect(dto.distributorLogoUrl).toBeNull();
    expect(logosDeLasEmpresas).not.toHaveBeenCalled();
    expect(urlDe).not.toHaveBeenCalled();
  });
});
