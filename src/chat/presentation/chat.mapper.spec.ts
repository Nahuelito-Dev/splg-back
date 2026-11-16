import type { ContextoDeVista } from '../application/chat-views.service';
import { MessageKind, MessageVisibility, Party } from '../domain/chat.enums';
import { Message } from '../entities/message.entity';
import { ChatMapper } from './chat.mapper';

const fuentes = [
  { type: 'faq', faqId: 'faq-1', question: '¿Cómo cargo un chofer?' },
];

const respuesta = Object.assign(new Message(), {
  messageId: 'm-1',
  conversationId: 'conv-1',
  distributorId: 'dist-a',
  seq: 3,
  clientMessageId: null,
  senderParty: Party.SYSTEM,
  senderUserId: null,
  kind: MessageKind.AUTO_REPLY,
  visibility: MessageVisibility.ALL,
  body: 'Desde Personal → Choferes.',
  bodyFiltered: false,
  templateKey: 'asistente_ia',
  systemCode: null,
  payload: {
    senderLabel: 'Asistente de OrixTech',
    ai: { model: 'claude-haiku-5-5', sources: fuentes },
  },
  redactedAt: null,
  createdAt: new Date('2026-11-15T12:00:00Z'),
});

const ctx = (party: Party.COMPANY | Party.PLATFORM) =>
  ({
    observador: { party, userId: 'u' },
    plataforma: 'OrixTech',
    nombres: new Map(),
    empresas: new Map(),
    noLeidos: new Map(),
    lecturaDeLaOtraParte: new Map(),
    lecturaPropia: new Map(),
    ultimos: new Map(),
    citados: new Map(),
    ticketsDesde: new Map(),
    ticketDelHilo: new Map(),
    sesiones: new Map(),
  }) as ContextoDeVista;

describe('ChatMapper: fuentes del asistente en el soporte (C1, 4d)', () => {
  it('la plataforma ve `ai.sources`; la empresa (la otra punta) nunca', () => {
    expect(ChatMapper.mensaje(respuesta, ctx(Party.PLATFORM)).payload).toEqual(
      respuesta.payload,
    );
    expect(ChatMapper.mensaje(respuesta, ctx(Party.COMPANY)).payload).toEqual({
      senderLabel: 'Asistente de OrixTech',
      ai: { model: 'claude-haiku-5-5' },
    });
  });
});
