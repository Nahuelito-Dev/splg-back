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
    adjuntos: new Map(),
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

describe('ChatMapper: adjuntos en el soporte (CH7)', () => {
  const adjunto = Object.assign(new Message(), {
    ...respuesta,
    messageId: 'm-adj',
    senderParty: Party.COMPANY,
    kind: MessageKind.ATTACHMENT,
    body: null,
    templateKey: null,
    payload: { media: 'file' },
  });
  const conAdjunto = (party: Party.COMPANY | Party.PLATFORM) => {
    const c = ctx(party);
    c.adjuntos.set('m-adj', {
      attachmentId: 'adj-1',
      originalName: 'factura.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 99,
      scanStatus: 'pending',
      width: null,
      height: null,
      storageKey: 'secreta',
    } as never);
    return c;
  };

  it('el mensaje trae el adjunto (sin URL) para las dos puntas', () => {
    for (const party of [Party.COMPANY, Party.PLATFORM] as const) {
      const dto = ChatMapper.mensaje(adjunto, conAdjunto(party));
      expect(dto.attachment).toEqual({
        id: 'adj-1',
        fileName: 'factura.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 99,
        scanStatus: 'pending',
        width: null,
        height: null,
      });
      expect(JSON.stringify(dto)).not.toContain('secreta');
    }
  });

  it('redactado: sin adjunto', () => {
    const dto = ChatMapper.mensaje(
      Object.assign(new Message(), { ...adjunto, redactedAt: new Date() }),
      conAdjunto(Party.COMPANY),
    );
    expect(dto.attachment).toBeNull();
  });

  it('la vista previa del ticket es «📎 Archivo»', () => {
    const c = conAdjunto(Party.COMPANY);
    c.ultimos.set('hilo', adjunto);
    const t = ChatMapper.ticketResumen(
      {
        ticketId: 't',
        number: 1,
        subject: 'x',
        status: 'open',
        priority: 'normal',
        updatedAt: new Date(),
        conversationId: 'hilo',
      } as never,
      c,
    );
    expect(t.lastMessage?.preview).toBe('📎 Archivo');
  });
});
