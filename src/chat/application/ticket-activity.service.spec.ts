import type { DataSource, EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  MessageVisibility,
  Party,
  SystemCode,
  TicketPriority,
  TicketStatus,
} from '../domain/chat.enums';
import {
  TicketCerradoError,
  TicketNoEncontradoError,
  TicketNoResueltoError,
  TransicionDeTicketInvalidaError,
} from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import { SupportTicket } from '../entities/support-ticket.entity';
import type { ChatReadModel } from '../infrastructure/chat-read-model';
import type { ChatEvents } from './chat.events';
import type { ChatNotices } from './chat-notices';
import type { ChatRateLimit } from './chat-rate-limit';
import type { MessageWriter } from './message-writer';
import type { NuevoMensaje } from './mensajes.port';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from './support-settings.service';
import { TicketActivityService } from './ticket-activity.service';
import { TicketState } from './ticket-state';

const EMPRESA = 'dist-a';

function ticket(extra: Partial<SupportTicket> = {}): SupportTicket {
  return Object.assign(new SupportTicket(), {
    ticketId: 't1',
    distributorId: EMPRESA,
    conversationId: 'hilo-1',
    originConversationId: null,
    number: 123,
    subject: 'Factura duplicada',
    priority: TicketPriority.NORMAL,
    status: TicketStatus.NEW,
    statusChangedAt: new Date('2026-11-10T10:00:00Z'),
    assignedMemberUserId: null,
    firstResponseAt: null,
    firstResponseDueAt: null,
    resolvedAt: null,
    closedAt: null,
    satisfaction: null,
    createdAt: new Date('2026-11-10T10:00:00Z'),
    updatedAt: new Date('2026-11-10T10:00:00Z'),
    ...extra,
  });
}

describe('TicketActivityService: respuestas, notas internas y estados', () => {
  let actual: SupportTicket | null;
  let hilo: Conversation;
  let escritos: NuevoMensaje[];
  let reintento: boolean;
  let buscado: unknown;
  let guardados: SupportTicket[];
  let avisos: { respuestaDeLaPlataforma: jest.Mock; resuelto: jest.Mock };
  let service: TicketActivityService;
  let cupos: { mensaje: jest.Mock };

  beforeEach(() => {
    actual = ticket();
    hilo = Object.assign(new Conversation(), {
      conversationId: 'hilo-1',
      distributorId: EMPRESA,
      channel: Channel.PLATFORM_TICKET,
      status: ConversationStatus.OPEN,
    });
    escritos = [];
    reintento = false;
    guardados = [];
    const manager = {
      getRepository: (entidad: unknown) =>
        entidad === SupportTicket
          ? {
              findOne: (opciones: { where: unknown }) => {
                buscado = opciones.where;
                const w = opciones.where as { distributorId?: string };
                if (!actual) return Promise.resolve(null);
                if (w.distributorId && w.distributorId !== actual.distributorId)
                  return Promise.resolve(null);
                return Promise.resolve(actual);
              },
              save: (t: SupportTicket) => {
                guardados.push({ ...t } as SupportTicket);
                return Promise.resolve(t);
              },
            }
          : {
              findOneByOrFail: () => Promise.resolve(hilo),
              save: (c: Conversation) => Promise.resolve(c),
            },
    } as unknown as EntityManager;
    const dataSource = {
      transaction: <T>(fn: (m: EntityManager) => Promise<T>) => fn(manager),
    } as unknown as DataSource;
    const writer = {
      escribir: jest.fn((_m: EntityManager, n: NuevoMensaje) => {
        escritos.push(n);
        return Promise.resolve({
          created: !reintento,
          conversation: hilo,
          message: {
            messageId: `msg-${escritos.length}`,
            createdAt: new Date('2026-11-14T12:00:00Z'),
            ...n,
          } as unknown as Message,
        });
      }),
    } as unknown as MessageWriter;
    avisos = { respuestaDeLaPlataforma: jest.fn(), resuelto: jest.fn() };
    cupos = { mensaje: jest.fn(() => Promise.resolve()) };
    service = new TicketActivityService(
      dataSource,
      writer,
      new TicketState(writer),
      {
        leer: () => Promise.resolve(configuracionPorDefecto()),
      } as unknown as SupportSettingsService,
      {
        esMiembroDeLaPlataforma: (id: string) =>
          Promise.resolve(id === 'super-2'),
      } as unknown as ChatReadModel,
      cupos as unknown as ChatRateLimit,
      { publicar: jest.fn() } as unknown as ChatEvents,
      avisos as unknown as ChatNotices,
    );
  });

  const empresa = {
    party: Party.COMPANY,
    userId: 'admin-a',
    distributorId: EMPRESA,
  } as const;
  const plataforma = {
    party: Party.PLATFORM,
    userId: 'super-1',
    distributorId: null,
  } as const;
  const dto = {
    clientMessageId: '6b1f0a4e-1111-4c1e-9d55-2f0b8f1a9e10',
    body: 'Hola',
  };
  const sistema = () => escritos.filter((e) => e.systemCode !== null);

  it('la marca de reintento lleva la empresa (o el ticket, si responde la plataforma)', async () => {
    await service.responder(empresa, 't1', dto);
    expect(cupos.mensaje).toHaveBeenLastCalledWith({
      ambito: EMPRESA,
      userId: 'admin-a',
      clientMessageId: dto.clientMessageId,
    });
    await service.responder(plataforma, 't1', dto);
    expect(cupos.mensaje).toHaveBeenLastCalledWith({
      ambito: 'ticket:t1',
      userId: 'super-1',
      clientMessageId: dto.clientMessageId,
    });
  });

  it('la empresa responde a uno que la esperaba: vuelve a open y queda el mensaje de sistema', async () => {
    actual = ticket({ status: TicketStatus.WAITING_COMPANY });
    await service.responder(empresa, 't1', dto);
    expect(actual.status).toBe(TicketStatus.OPEN);
    expect(sistema()).toEqual([
      expect.objectContaining({
        systemCode: SystemCode.TICKET_STATUS_CHANGED,
        payload: expect.objectContaining({
          from: 'waiting_company',
          to: 'open',
        }) as unknown,
      }),
    ]);
    expect(avisos.respuestaDeLaPlataforma).not.toHaveBeenCalled();
  });

  it('la plataforma responde uno nuevo: queda esperando a la empresa, con primera respuesta, asignado y aviso', async () => {
    await service.responder(plataforma, 't1', dto);
    expect(actual).toMatchObject({
      status: TicketStatus.WAITING_COMPANY,
      assignedMemberUserId: 'super-1',
      firstResponseAt: new Date('2026-11-14T12:00:00Z'),
    });
    expect(avisos.respuestaDeLaPlataforma).toHaveBeenCalledTimes(1);
  });

  it('una nota interna no mueve el estado, no cuenta como respuesta y no avisa a la empresa', async () => {
    await service.responder(plataforma, 't1', dto, MessageVisibility.INTERNAL);
    expect(actual).toMatchObject({
      status: TicketStatus.NEW,
      firstResponseAt: null,
    });
    expect(escritos).toEqual([
      expect.objectContaining({ visibility: MessageVisibility.INTERNAL }),
    ]);
    expect(avisos.respuestaDeLaPlataforma).not.toHaveBeenCalled();
  });

  it('un reintento (mismo clientMessageId) no vuelve a mover el estado', async () => {
    actual = ticket({ status: TicketStatus.WAITING_COMPANY });
    reintento = true;
    await service.responder(empresa, 't1', dto);
    expect(actual.status).toBe(TicketStatus.WAITING_COMPANY);
    expect(guardados).toHaveLength(0);
  });

  it('responder en un cerrado es 409 y no escribe nada', async () => {
    actual = ticket({ status: TicketStatus.CLOSED, closedAt: new Date() });
    await expect(service.responder(empresa, 't1', dto)).rejects.toBeInstanceOf(
      TicketCerradoError,
    );
    expect(escritos).toHaveLength(0);
  });

  it('el ticket de otra empresa es 404: se busca con la empresa de quien pide', async () => {
    actual = ticket({ distributorId: 'dist-b' });
    await expect(service.responder(empresa, 't1', dto)).rejects.toBeInstanceOf(
      TicketNoEncontradoError,
    );
    expect(buscado).toEqual({ ticketId: 't1', distributorId: EMPRESA });
    expect(escritos).toHaveLength(0);
  });

  it('PATCH con una transición inválida es 400 y no guarda', async () => {
    await expect(
      service.actualizar('super-1', 't1', { status: TicketStatus.CLOSED }),
    ).rejects.toBeInstanceOf(TransicionDeTicketInvalidaError);
    expect(guardados).toHaveLength(0);
  });

  it('resolver deja la fecha y avisa a la empresa; el equipo no lo puede cerrar a mano', async () => {
    actual = ticket({ status: TicketStatus.WAITING_COMPANY });
    await service.actualizar('super-1', 't1', {
      status: TicketStatus.RESOLVED,
    });
    expect(actual.resolvedAt).toBeInstanceOf(Date);
    expect(avisos.resuelto).toHaveBeenCalledTimes(1);
    await expect(
      service.actualizar('super-1', 't1', { status: TicketStatus.CLOSED }),
    ).rejects.toBeInstanceOf(TransicionDeTicketInvalidaError);
    expect({ ticket: actual.status, hilo: hilo.status }).toEqual({
      ticket: TicketStatus.RESOLVED,
      hilo: ConversationStatus.OPEN,
    });
  });

  it('esperando a la empresa tampoco se cierra a mano: lo cierra el vencimiento', async () => {
    actual = ticket({ status: TicketStatus.WAITING_COMPANY });
    await expect(
      service.actualizar('super-1', 't1', { status: TicketStatus.CLOSED }),
    ).rejects.toBeInstanceOf(TransicionDeTicketInvalidaError);
    expect(guardados).toHaveLength(0);
  });

  it('asignar uno nuevo lo pasa a open; a alguien que no es de la plataforma, 400', async () => {
    await service.actualizar('super-1', 't1', { assignedTo: 'super-2' });
    expect(actual).toMatchObject({
      status: TicketStatus.OPEN,
      assignedMemberUserId: 'super-2',
    });
    await expect(
      service.actualizar('super-1', 't1', { assignedTo: 'admin-a' }),
    ).rejects.toMatchObject({ response: { code: 'TICKET_ASSIGNEE_INVALID' } });
  });

  it('un PATCH vacío es 400', async () => {
    await expect(service.actualizar('super-1', 't1', {})).rejects.toMatchObject(
      {
        status: 400,
      },
    );
  });

  it('cambiar la prioridad sin primera respuesta recalcula el vencimiento', async () => {
    await service.actualizar('super-1', 't1', {
      priority: TicketPriority.URGENT,
    });
    expect(actual?.firstResponseDueAt).toEqual(
      new Date('2026-11-10T11:00:00Z'),
    );
  });

  it('la empresa confirma un resuelto (con calificación) y se cierra; uno no resuelto es 409', async () => {
    actual = ticket({ status: TicketStatus.RESOLVED, resolvedAt: new Date() });
    await service.confirmar(EMPRESA, 't1', 5);
    expect(actual).toMatchObject({
      status: TicketStatus.CLOSED,
      satisfaction: 5,
    });
    actual = ticket({ status: TicketStatus.OPEN });
    await expect(service.confirmar(EMPRESA, 't1', 4)).rejects.toBeInstanceOf(
      TicketNoResueltoError,
    );
  });
});
