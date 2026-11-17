import { ajustesDeLaBandejaPorDefecto } from '../application/company-chat-settings.service';
import type { CompanyChatSettingsService } from '../application/company-chat-settings.service';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
  SystemCode,
} from '../domain/chat.enums';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { BandejaReadModel } from '../infrastructure/bandeja-read-model';
import type { Lector } from '../infrastructure/chat-read-model';
import { BandejaPresenter, payloadPara } from './bandeja.presenter';

const D = 'dist-a';

function conversacion(cambios: Partial<Conversation> = {}): Conversation {
  return Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: D,
    channel: Channel.STAFF_CUSTOMER,
    subjectType: SubjectType.GENERAL,
    status: ConversationStatus.OPEN,
    orderId: null,
    customerUserId: 'cli-1',
    driverUserId: null,
    linkedClaimId: null,
    assignedToUserId: 'adm-1',
    firstResponseAt: new Date('2026-11-16T12:20:00Z'),
    closedReason: null,
    lastMessageSeq: 3,
    createdAt: new Date('2026-11-16T12:00:00Z'),
    updatedAt: new Date('2026-11-16T12:20:00Z'),
    ...cambios,
  });
}

function mensaje(cambios: Partial<Message> = {}): Message {
  return Object.assign(new Message(), {
    messageId: 'm-2',
    conversationId: 'conv-1',
    distributorId: D,
    seq: 2,
    clientMessageId: 'cm-2',
    senderParty: Party.COMPANY,
    senderUserId: 'adm-1',
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: 'Te respondo',
    payload: null,
    templateKey: null,
    systemCode: null,
    replyToSeq: 1,
    editedAt: null,
    withdrawnAt: null,
    withdrawnByUserId: null,
    redactedAt: null,
    createdAt: new Date(),
    ...cambios,
  });
}

const respondido = mensaje({
  messageId: 'm-1',
  seq: 1,
  senderParty: Party.CUSTOMER,
  senderUserId: 'cli-1',
  body: 'Hola, ¿a qué hora reparten?',
  replyToSeq: null,
});

function presentador(
  extra: Partial<ChatCompanySettings> = {},
  ultimo: Message = mensaje(),
  /** Los mensajes atados (pedido, reclamo, ticket o citados) según la base. */
  atados: readonly string[] = [],
) {
  const lectura = {
    noLeidos: jest.fn().mockResolvedValue(new Map([['conv-1', 2]])),
    lecturaPropia: jest.fn().mockResolvedValue(new Map([['conv-1', 1]])),
    lecturaDeLaOtraParte: jest.fn().mockResolvedValue(new Map([['conv-1', 2]])),
    ultimos: jest.fn().mockResolvedValue(new Map([['conv-1', ultimo]])),
    respondidos: jest
      .fn()
      .mockResolvedValue(new Map([['conv-1:1', respondido]])),
    primerMensajeEntrante: jest
      .fn()
      .mockResolvedValue(
        new Map([['conv-1', new Date('2026-11-16T12:05:00Z')]]),
      ),
    pedidos: jest.fn().mockResolvedValue(new Map()),
    nombres: jest.fn().mockResolvedValue(
      new Map([
        ['cli-1', 'Ana Pérez'],
        ['adm-1', 'Lucía Gómez'],
      ]),
    ),
    empresas: jest.fn().mockResolvedValue(new Map([[D, 'Gas Norte']])),
    marcas: jest.fn((ids: Iterable<string>) =>
      Promise.resolve(
        new Map([...ids].map((id) => [id, 'Florchi Gas'] as [string, string])),
      ),
    ),
    atados: jest.fn((ids: readonly string[]) =>
      Promise.resolve(new Set(ids.filter((id) => atados.includes(id)))),
    ),
    menciones: jest.fn((ids: readonly string[]) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [id, [{ userId: 'adm-2', fullName: 'Juan Ruiz' }]]),
        ),
      ),
    ),
    mencionesSinLeer: jest.fn().mockResolvedValue(new Map([['conv-1', 1]])),
    encuestas: jest.fn().mockResolvedValue(new Map()),
    primerMensajeDelAsistente: jest.fn().mockResolvedValue(new Map()),
    adjuntos: jest.fn().mockResolvedValue(new Map()),
    etiquetas: jest.fn().mockResolvedValue(new Map()),
  };
  const ajustes = {
    leer: jest.fn().mockResolvedValue({
      ...ajustesDeLaBandejaPorDefecto(D),
      // Lunes de 9 a 9:10 (Buenos Aires): de 9:05 a 9:20 sólo cuentan 5 minutos.
      businessHours: [{ weekday: 1, opensAt: '09:00', closesAt: '09:10' }],
      ...extra,
    }),
  };
  return Object.assign(
    new BandejaPresenter(
      lectura as unknown as BandejaReadModel,
      ajustes as unknown as CompanyChatSettingsService,
    ),
    { base: lectura },
  );
}

describe('BandejaPresenter: adjuntos (CH7)', () => {
  const adjunto = {
    attachmentId: 'adj-1',
    messageId: 'm-2',
    originalName: 'casa.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1234,
    scanStatus: 'clean',
    width: 40,
    height: 20,
    storageKey: 'd/x/chat/conv-1/a.jpg',
  };
  const deAdjunto = (cambios: Partial<Message> = {}) =>
    mensaje({
      kind: MessageKind.ATTACHMENT,
      body: 'La puerta',
      payload: { media: 'photo' },
      replyToSeq: null,
      ...cambios,
    });

  it('el mensaje trae el adjunto sin URL ni key, y la lista dice «📎 Foto»', async () => {
    const p = presentador({}, deAdjunto());
    p.base.adjuntos.mockResolvedValue(new Map([['m-2', adjunto]]));
    const m = await p.mensaje(deAdjunto(), {
      party: Party.CUSTOMER,
      userId: 'cli-1',
    });
    expect(m.attachment).toEqual({
      id: 'adj-1',
      fileName: 'casa.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
      scanStatus: 'clean',
      width: 40,
      height: 20,
    });
    expect(JSON.stringify(m)).not.toContain('d/x/chat');
    expect(m.body).toBe('La puerta');
    const c = await p.conversacion(conversacion(), {
      party: Party.COMPANY,
      userId: 'adm-1',
    });
    expect(c.lastMessage?.preview).toBe('📎 Foto');
  });

  it('redactado: sin adjunto ni epígrafe', async () => {
    const p = presentador();
    p.base.adjuntos.mockResolvedValue(new Map([['m-2', adjunto]]));
    const m = await p.mensaje(
      deAdjunto({ redactedAt: new Date(), body: null }),
      { party: Party.COMPANY, userId: 'adm-1' },
    );
    expect(m.attachment).toBeNull();
  });
});

describe('BandejaPresenter: lo que ve cada punta', () => {
  it('el cliente ve la marca de la empresa, nunca al operador (D-C5)', async () => {
    const p = presentador();
    const c = await p.conversacion(conversacion(), {
      party: Party.CUSTOMER,
      userId: 'cli-1',
    });
    expect(c.counterpart).toEqual({
      party: Party.COMPANY,
      displayName: 'Florchi Gas',
    });
    expect(c).not.toHaveProperty('assignedTo');
    expect(c).not.toHaveProperty('assignedAutomatically');
    expect(c).not.toHaveProperty('customer');
    expect(c).not.toHaveProperty('firstResponseBusinessMinutes');
    const m = await p.mensaje(mensaje(), {
      party: Party.CUSTOMER,
      userId: 'cli-1',
    });
    expect(m.sender).toEqual({ displayName: 'Florchi Gas' });
    expect(m.isMine).toBe(false);
    expect(m.clientMessageId).toBeNull();
  });

  it('el cliente y el chofer ven el nombre de marca (el mismo de la firma del asistente), no el legal', async () => {
    const p = presentador();
    const chofer = { party: Party.DRIVER, userId: 'cho-1' } as const;
    const c = await p.conversacion(
      conversacion({
        channel: Channel.STAFF_DRIVER,
        customerUserId: null,
        driverUserId: 'cho-1',
      }),
      chofer,
    );
    expect(c.counterpart.displayName).toBe('Florchi Gas');
    expect((await p.mensaje(mensaje(), chofer)).sender).toEqual({
      displayName: 'Florchi Gas',
    });
    // El nombre de la empresa sale de la marca (o del legal si no tiene): no se pide el legal.
    expect(p.base.marcas).toHaveBeenCalledWith(new Set([D]));
    expect(p.base.empresas).not.toHaveBeenCalled();
  });

  it('el personal sigue viendo lo de hoy: al cliente o al chofer, y a quien escribió por su nombre', async () => {
    const p = presentador();
    const personal = { party: Party.COMPANY, userId: 'adm-2' } as const;
    const c = await p.conversacion(conversacion(), personal);
    expect(c.counterpart).toEqual({
      party: Party.CUSTOMER,
      displayName: 'Ana Pérez',
    });
    expect((await p.mensaje(mensaje(), personal)).sender).toEqual({
      displayName: 'Lucía Gómez',
      userId: 'adm-1',
    });
  });

  it('el id de quien escribió (para la foto) sólo le llega al personal', async () => {
    const p = presentador();
    const personal = await p.mensaje(mensaje(), {
      party: Party.COMPANY,
      userId: 'adm-2',
    });
    expect(personal.sender).toEqual(
      expect.objectContaining({ userId: 'adm-1' }),
    );
    const cliente = await p.mensaje(mensaje(), {
      party: Party.CUSTOMER,
      userId: 'cli-1',
    });
    expect(cliente.sender).not.toHaveProperty('userId');
  });

  it('en la lista, el aviso de recibido se lee con su texto; otro aviso del sistema, sin texto', async () => {
    const recibido = mensaje({
      senderParty: Party.SYSTEM,
      senderUserId: null,
      kind: MessageKind.SYSTEM,
      systemCode: SystemCode.RECEIVED_ACK,
      body: 'Recibimos tu mensaje.',
    });
    const personal = { party: Party.COMPANY, userId: 'adm-1' } as const;
    const conAviso = await presentador({}, recibido).conversacion(
      conversacion(),
      personal,
    );
    expect(conAviso.lastMessage?.preview).toBe('Recibimos tu mensaje.');
    const reclamo = mensaje({
      ...recibido,
      systemCode: SystemCode.CLAIM_CREATED,
    });
    const conReclamo = await presentador({}, reclamo).conversacion(
      conversacion(),
      personal,
    );
    expect(conReclamo.lastMessage?.preview).toBeNull();
  });

  it('si el asistente con IA la derivó, el personal ve desde cuándo espera a una persona; el cliente no', async () => {
    const derivada = new Date('2026-11-15T12:00:00Z');
    const p = presentador();
    const personal = await p.conversacion(
      conversacion({ awaitingHumanSince: derivada }),
      { party: Party.COMPANY, userId: 'adm-1' },
    );
    expect(personal.awaitingHumanSince).toBe('2026-11-15T12:00:00.000Z');
    const sinDerivar = await p.conversacion(conversacion(), {
      party: Party.COMPANY,
      userId: 'adm-1',
    });
    expect(sinDerivar.awaitingHumanSince).toBeNull();
    const cliente = await p.conversacion(
      conversacion({ awaitingHumanSince: derivada }),
      { party: Party.CUSTOMER, userId: 'cli-1' },
    );
    expect(cliente).not.toHaveProperty('awaitingHumanSince');
  });

  it('el personal ve al cliente, quién atiende y el TPR en minutos hábiles', async () => {
    const c = await presentador().conversacion(conversacion(), {
      party: Party.COMPANY,
      userId: 'adm-1',
    });
    expect(c.counterpart).toEqual({
      party: Party.CUSTOMER,
      displayName: 'Ana Pérez',
    });
    expect(c.customer).toEqual({ id: 'cli-1', displayName: 'Ana Pérez' });
    expect(c.assignedTo).toEqual({ userId: 'adm-1', fullName: 'Lucía Gómez' });
    expect(c.assignedAutomatically).toBe(false);
    expect(c.firstResponseBusinessMinutes).toBe(5);
    expect(c.unreadCount).toBe(2);
    expect(c.lastReadSeq).toBe(1);
  });

  it('el personal ve si la asignó la asignación automática (8b)', async () => {
    const c = await presentador().conversacion(
      conversacion({ assignedAutomatically: true }),
      { party: Party.COMPANY, userId: 'adm-1' },
    );
    expect(c.assignedAutomatically).toBe(true);
  });

  it('respuesta con cita y edición: lo que cita y la marca; el autor puede editar en los 15 minutos', async () => {
    const m = await presentador().mensaje(mensaje({ editedAt: new Date() }), {
      party: Party.COMPANY,
      userId: 'adm-1',
    });
    expect(m.replyTo).toEqual({
      seq: 1,
      party: Party.CUSTOMER,
      preview: 'Hola, ¿a qué hora reparten?',
    });
    expect(m.editedAt).not.toBeNull();
    expect(m.canEdit).toBe(true);
    const deOtro = await presentador().mensaje(mensaje(), {
      party: Party.COMPANY,
      userId: 'adm-9',
    });
    expect(deOtro.canEdit).toBe(false);
    expect(deOtro.isMine).toBe(true);
  });

  it('canEdit: lo que quedó atado (pedido, reclamo, ticket o citado) no se ofrece editar, como en el PATCH', async () => {
    const autor = { party: Party.COMPANY, userId: 'adm-1' } as const;
    const libre = mensaje({ messageId: 'm-libre' });
    const atado = mensaje({ messageId: 'm-atado' });
    const p = presentador({}, mensaje(), ['m-atado']);
    const [a, b] = await p.mensajes([libre, atado], autor);
    expect(a.canEdit).toBe(true);
    expect(b.canEdit).toBe(false);
    // También el cliente con su mensaje.
    const delCliente = mensaje({
      messageId: 'm-atado',
      senderParty: Party.CUSTOMER,
      senderUserId: 'cli-1',
    });
    expect(
      (
        await p.mensaje(delCliente, {
          party: Party.CUSTOMER,
          userId: 'cli-1',
        })
      ).canEdit,
    ).toBe(false);
  });

  it('canEdit: a la base sólo se le preguntan los que pasarían el plazo y son de quien mira', async () => {
    const p = presentador();
    await p.mensajes(
      [
        mensaje({ messageId: 'm-propio' }),
        mensaje({ messageId: 'm-viejo', createdAt: new Date(0) }),
        mensaje({ messageId: 'm-ajeno', senderUserId: 'adm-9' }),
        mensaje({ messageId: 'm-borrado', withdrawnAt: new Date() }),
        mensaje({ messageId: 'm-aviso', kind: MessageKind.SYSTEM }),
      ],
      { party: Party.COMPANY, userId: 'adm-1' },
    );
    expect(p.base.atados).toHaveBeenCalledWith(['m-propio']);
  });

  it('un mensaje borrado por su autor (D-C23) no lleva el texto, para nadie', async () => {
    const borrado = mensaje({
      senderParty: Party.CUSTOMER,
      senderUserId: 'cli-1',
      body: 'Esto no se ve',
      withdrawnAt: new Date(),
      withdrawnByUserId: 'cli-1',
    });
    for (const quien of [
      { party: Party.COMPANY, userId: 'adm-1' } as const,
      { party: Party.CUSTOMER, userId: 'cli-1' } as const,
    ]) {
      const m = await presentador().mensaje(borrado, quien);
      expect(m.deleted).toBe(true);
      expect(m.body).toBeNull();
      expect(m.canEdit).toBe(false);
      expect(JSON.stringify(m)).not.toContain('Esto no se ve');
    }
  });

  it('con el chat de clientes apagado, el cliente no puede escribir y el personal sí', async () => {
    const lectura = {
      noLeidos: jest.fn().mockResolvedValue(new Map()),
      lecturaPropia: jest.fn().mockResolvedValue(new Map()),
      lecturaDeLaOtraParte: jest.fn().mockResolvedValue(new Map()),
      ultimos: jest.fn().mockResolvedValue(new Map()),
      respondidos: jest.fn().mockResolvedValue(new Map()),
      primerMensajeEntrante: jest.fn().mockResolvedValue(new Map()),
      pedidos: jest.fn().mockResolvedValue(new Map()),
      nombres: jest.fn().mockResolvedValue(new Map()),
      empresas: jest.fn().mockResolvedValue(new Map()),
      marcas: jest.fn().mockResolvedValue(new Map()),
      atados: jest.fn().mockResolvedValue(new Set()),
      menciones: jest.fn().mockResolvedValue(new Map()),
      mencionesSinLeer: jest.fn().mockResolvedValue(new Map()),
      encuestas: jest.fn().mockResolvedValue(new Map()),
      primerMensajeDelAsistente: jest.fn().mockResolvedValue(new Map()),
      adjuntos: jest.fn().mockResolvedValue(new Map()),
      etiquetas: jest.fn().mockResolvedValue(new Map()),
    };
    const p = new BandejaPresenter(
      lectura as unknown as BandejaReadModel,
      {
        leer: jest.fn().mockResolvedValue({
          ...ajustesDeLaBandejaPorDefecto(D),
          customerChatEnabled: false,
        }),
      } as unknown as CompanyChatSettingsService,
    );
    expect(
      (
        await p.conversacion(conversacion(), {
          party: Party.CUSTOMER,
          userId: 'cli-1',
        })
      ).canWrite,
    ).toBe(false);
    expect(
      (
        await p.conversacion(conversacion(), {
          party: Party.COMPANY,
          userId: 'adm-1',
        })
      ).canWrite,
    ).toBe(true);
  });

  it('lo que manda el asistente lleva la marca y su nombre, para el cliente y para el personal (D-B5, D-B8)', async () => {
    const fuera = mensaje({
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.AUTO_REPLY,
      body: 'Ahora estamos fuera de horario.',
      templateKey: 'fuera_de_horario',
      payload: { until: '2026-11-17T12:00:00.000Z' },
      replyToSeq: null,
    });
    const recibido = mensaje({
      ...fuera,
      kind: MessageKind.SYSTEM,
      systemCode: SystemCode.RECEIVED_ACK,
      templateKey: 'recibido',
      payload: null,
    });
    const reclamo = mensaje({
      ...recibido,
      systemCode: SystemCode.CLAIM_CREATED,
      templateKey: null,
    });
    const lectores: Lector[] = [
      { party: Party.CUSTOMER, userId: 'cli-1' },
      { party: Party.COMPANY, userId: 'adm-1' },
    ];
    for (const quien of lectores) {
      const [a, b, c, d] = await presentador().mensajes(
        [fuera, recibido, reclamo, mensaje()],
        quien,
      );
      // Sin firma guardada (anteriores a B1): el nombre vigente, con la marca.
      expect([a.automated, a.senderLabel]).toEqual([
        true,
        'Asistente de Florchi Gas',
      ]);
      expect([b.automated, b.senderLabel]).toEqual([
        true,
        'Asistente de Florchi Gas',
      ]);
      expect([c.automated, c.senderLabel]).toEqual([false, null]);
      expect([d.automated, d.senderLabel]).toEqual([false, null]);
    }
    const propio = await presentador({
      assistantName: 'Gasito de {{empresa.nombre}}',
    }).mensaje(fuera, { party: Party.CUSTOMER, userId: 'cli-1' });
    expect(propio.senderLabel).toBe('Gasito de Florchi Gas');
  });

  it('la firma guardada al mandarlo manda: cambiar el nombre del asistente no reescribe el historial', async () => {
    const firmado = mensaje({
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.AUTO_REPLY,
      body: 'Ahora estamos fuera de horario.',
      templateKey: 'fuera_de_horario',
      payload: {
        until: '2026-11-17T12:00:00.000Z',
        senderLabel: 'Asistente de Florchi Gas',
      },
      replyToSeq: null,
    });
    const p = presentador({ assistantName: 'Gasito' });
    const m = await p.mensaje(firmado, {
      party: Party.CUSTOMER,
      userId: 'cli-1',
    });
    expect([m.automated, m.senderLabel]).toEqual([
      true,
      'Asistente de Florchi Gas',
    ]);
    const recibido = await p.mensaje(
      mensaje({
        ...firmado,
        kind: MessageKind.SYSTEM,
        systemCode: SystemCode.RECEIVED_ACK,
        payload: { senderLabel: 'Asistente de Florchi Gas' },
      }),
      { party: Party.COMPANY, userId: 'adm-1' },
    );
    expect(recibido.senderLabel).toBe('Asistente de Florchi Gas');
  });

  describe('notas internas (4a), nota de derivación (4c) y fuentes (4d)', () => {
    const notaInterna = mensaje({
      messageId: 'm-9',
      seq: 9,
      visibility: MessageVisibility.INTERNAL,
      body: '@Juan fijate',
      replyToSeq: null,
    });
    const personal = { party: Party.COMPANY, userId: 'adm-1' } as const;

    it('el personal ve la nota marcada interna, con a quiénes menciona', async () => {
      const p = presentador();
      const m = await p.mensaje(notaInterna, personal);
      expect(m).toMatchObject({
        internal: true,
        body: '@Juan fijate',
        mentions: [{ userId: 'adm-2', fullName: 'Juan Ruiz' }],
      });
      expect(p.base.menciones).toHaveBeenCalledWith(['m-9']);
    });

    it('un mensaje visible no lleva menciones y a la base sólo se le preguntan las notas', async () => {
      const p = presentador();
      const m = await p.mensaje(mensaje(), personal);
      expect(m.internal).toBe(false);
      expect(m).not.toHaveProperty('mentions');
      expect(p.base.menciones).toHaveBeenCalledWith([]);
    });

    it('al cliente y al chofer no se les arman las menciones ni las sin leer', async () => {
      const p = presentador();
      for (const quien of [
        { party: Party.CUSTOMER, userId: 'cli-1' },
        { party: Party.DRIVER, userId: 'cho-1' },
      ] as const) {
        const c = await p.conversacion(conversacion(), quien);
        expect(c).not.toHaveProperty('unreadMentions');
        expect(await p.mensaje(mensaje(), quien)).not.toHaveProperty(
          'mentions',
        );
      }
      expect(p.base.menciones).not.toHaveBeenCalled();
      expect(p.base.mencionesSinLeer).not.toHaveBeenCalled();
    });

    it('el personal ve sus menciones sin leer en cada conversación', async () => {
      const p = presentador();
      const c = await p.conversacion(conversacion(), personal);
      expect(c.unreadMentions).toBe(1);
      expect(p.base.mencionesSinLeer).toHaveBeenCalledWith(['conv-1'], 'adm-1');
    });

    it('etiquetas (7c): el personal ve las de cada conversación; al cliente no le llegan ni se consultan', async () => {
      const p = presentador();
      const etiquetas = [{ id: 'et-1', name: 'Envíos', color: 'orange' }];
      p.base.etiquetas.mockResolvedValue(new Map([['conv-1', etiquetas]]));
      const delPersonal = await p.conversacion(conversacion(), personal);
      expect(delPersonal.labels).toEqual(etiquetas);
      expect(p.base.etiquetas).toHaveBeenCalledWith(['conv-1']);
      p.base.etiquetas.mockClear();
      const delCliente = await p.conversacion(conversacion(), {
        party: Party.CUSTOMER,
        userId: 'cli-1',
      });
      expect(delCliente).not.toHaveProperty('labels');
      expect(p.base.etiquetas).not.toHaveBeenCalled();
      const sinEtiquetas = await presentador().conversacion(
        conversacion(),
        personal,
      );
      expect(sinEtiquetas.labels).toEqual([]);
    });

    it('las fuentes de la respuesta del asistente (ai.sources) le llegan al personal y nunca al cliente', async () => {
      const fuentes = [
        { type: 'faq', faqId: 'faq-1', question: '¿Horario?' },
        { type: 'tool', tool: 'estado_de_mi_pedido', orderNumber: 'A1B2C3' },
      ];
      const respuesta = mensaje({
        senderParty: Party.SYSTEM,
        senderUserId: null,
        clientMessageId: null,
        kind: MessageKind.AUTO_REPLY,
        body: 'Tu pedido está en camino.',
        payload: {
          senderLabel: 'Gasito',
          ai: {
            model: 'claude-haiku-5-5',
            sources: fuentes as never,
          },
        },
        replyToSeq: null,
      });
      const p = presentador();
      expect((await p.mensaje(respuesta, personal)).payload).toEqual({
        senderLabel: 'Gasito',
        ai: { model: 'claude-haiku-5-5', sources: fuentes },
      });
      expect(
        (await p.mensaje(respuesta, { party: Party.CUSTOMER, userId: 'cli-1' }))
          .payload,
      ).toEqual({ senderLabel: 'Gasito', ai: { model: 'claude-haiku-5-5' } });
    });

    it('payloadPara deja igual lo que no trae fuentes', () => {
      expect(payloadPara(null, false)).toBeNull();
      expect(payloadPara({ claimId: 'c' }, false)).toEqual({ claimId: 'c' });
      expect(payloadPara({ ai: { model: 'x' } }, false)).toEqual({
        ai: { model: 'x' },
      });
    });

    it('la nota de derivación del asistente: interna, del sistema, sin marca de respuesta automática', async () => {
      const p = presentador();
      const m = await p.mensaje(
        mensaje({
          senderParty: Party.SYSTEM,
          senderUserId: null,
          clientMessageId: null,
          kind: MessageKind.SYSTEM,
          systemCode: SystemCode.HANDOFF_NOTE,
          visibility: MessageVisibility.INTERNAL,
          body: 'Motivo: El asistente tardó demasiado en responder',
          replyToSeq: null,
        }),
        personal,
      );
      expect(m).toMatchObject({
        internal: true,
        automated: false,
        senderLabel: null,
        systemCode: 'handoff_note',
        body: 'Motivo: El asistente tardó demasiado en responder',
        mentions: [{ userId: 'adm-2', fullName: 'Juan Ruiz' }],
      });
    });
  });

  describe('encuesta (4b) y botones de acción (4e)', () => {
    const cliente = { party: Party.CUSTOMER, userId: 'cli-1' } as const;
    const encuesta = {
      ratingId: 'r-1',
      conversationId: 'conv-1',
      distributorId: D,
      requestMessageId: 'm-8',
      customerUserId: 'cli-1',
      servedBy: 'assistant' as const,
      score: null,
      comment: null,
      requestedAt: new Date('2026-11-15T12:00:00Z'),
      expiresAt: new Date('2099-11-17T12:00:00Z'),
      answeredAt: null,
      cancelledAt: null,
    };

    it('la conversación con un cliente lleva la encuesta del último cierre; quién atendió, sólo para el personal', async () => {
      const p = presentador();
      p.base.encuestas.mockResolvedValue(new Map([['conv-1', encuesta]]));
      const base = {
        ratingId: 'r-1',
        status: 'pending',
        score: null,
        comment: null,
        requestedAt: '2026-11-15T12:00:00.000Z',
        expiresAt: '2099-11-17T12:00:00.000Z',
        answeredAt: null,
      };
      expect(
        (
          await p.conversacion(conversacion(), {
            party: Party.COMPANY,
            userId: 'adm-1',
          })
        ).csat,
      ).toEqual({ ...base, servedBy: 'assistant' });
      expect((await p.conversacion(conversacion(), cliente)).csat).toEqual(
        base,
      );
    });

    it('una encuesta anulada al reabrir se ve como `cancelled`', async () => {
      const p = presentador();
      p.base.encuestas.mockResolvedValue(
        new Map([
          [
            'conv-1',
            { ...encuesta, cancelledAt: new Date('2026-11-15T13:00:00Z') },
          ],
        ]),
      );
      expect((await p.conversacion(conversacion(), cliente)).csat?.status).toBe(
        'cancelled',
      );
    });

    it('sin encuesta, `csat: null`; con un chofer (C2) no hay encuesta ni se consulta', async () => {
      const p = presentador();
      expect((await p.conversacion(conversacion(), cliente)).csat).toBeNull();
      const c2 = await p.conversacion(
        conversacion({
          channel: Channel.STAFF_DRIVER,
          customerUserId: null,
          driverUserId: 'cho-1',
        }),
        { party: Party.DRIVER, userId: 'cho-1' },
      );
      expect(c2).not.toHaveProperty('csat');
    });

    const recibido = (seq: number) =>
      mensaje({
        messageId: `m-${seq}`,
        seq,
        senderParty: Party.SYSTEM,
        senderUserId: null,
        clientMessageId: null,
        kind: MessageKind.SYSTEM,
        systemCode: SystemCode.RECEIVED_ACK,
        body: 'Recibimos tu mensaje',
        replyToSeq: null,
      });

    it('al cliente, los botones que muestra la empresa van en el primer mensaje del asistente (en el orden del catálogo) y en ningún otro', async () => {
      const p = presentador({
        customerActions: ['talk_to_person', 'where_is_my_order'],
      });
      p.base.primerMensajeDelAsistente.mockResolvedValue(
        new Map([['conv-1', 2]]),
      );
      const [primero, otro] = await p.mensajes(
        [recibido(2), recibido(5)],
        cliente,
      );
      expect(primero.actions).toEqual([
        {
          key: 'where_is_my_order',
          label: '¿Dónde está mi pedido?',
          kind: 'message',
          text: '¿Dónde está mi pedido?',
        },
        {
          key: 'talk_to_person',
          label: 'Hablar con una persona',
          kind: 'handoff',
          text: 'Quiero hablar con una persona.',
        },
      ]);
      expect(otro).not.toHaveProperty('actions');
    });

    it('al personal no le llegan botones; al cliente, tampoco en un mensaje de la empresa ni con el chat apagado', async () => {
      const p = presentador();
      p.base.primerMensajeDelAsistente.mockResolvedValue(
        new Map([['conv-1', 2]]),
      );
      expect(
        await p.mensaje(recibido(2), { party: Party.COMPANY, userId: 'adm-1' }),
      ).not.toHaveProperty('actions');
      expect(p.base.primerMensajeDelAsistente).not.toHaveBeenCalled();
      expect(await p.mensaje(mensaje({ seq: 2 }), cliente)).not.toHaveProperty(
        'actions',
      );
      const apagado = presentador({ customerChatEnabled: false });
      apagado.base.primerMensajeDelAsistente.mockResolvedValue(
        new Map([['conv-1', 2]]),
      );
      expect(await apagado.mensaje(recibido(2), cliente)).not.toHaveProperty(
        'actions',
      );
    });
  });
});
