/**
 * Matriz HTTP de la mensajería CH1: chat con la plataforma (C1a) y tickets
 * (C1b), diseño `DISENO-COMUNICACION.md` §14.4, §14.5 y criterios de CH1.
 * Dos empresas (A y B), su gente y un super admin. Cada caso que deja estado
 * prepara lo suyo (`antes`) para no depender del orden. El socket se prueba
 * en el script en vivo (`.orq/vivo-chat-ch1.mjs`) y en los unitarios del
 * gateway y del listener.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SupportHousekeepingCron } from '../../../src/chat/application/support-housekeeping.cron';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Caso,
  Escenario,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
} from './matriz';

interface Ctx extends Escenario {
  env: TestEnv;
  /** Chat abierto de A con 10 mensajes (la mitad de la plataforma). */
  chatA: string;
  /** Chat abierto de B. */
  chatB: string;
  /** Ticket abierto de A, abierto por la empresa. */
  ticketA: string;
  /** Ticket de B. */
  ticketB: string;
  p: Record<string, string>;
}

const mensaje = (body = 'Hola, necesito ayuda') => ({
  clientMessageId: randomUUID(),
  body,
});

const ticketNuevo = (extra: object = {}) => ({
  category: 'billing',
  priority: 'normal',
  subject: 'Factura de octubre duplicada',
  firstMessage: mensaje('Nos llegó dos veces la factura'),
  ...extra,
});

type Cuerpo = Record<string, unknown>;
const items = (b: unknown): Cuerpo[] => ((b as Cuerpo).items ?? []) as Cuerpo[];
// Ayudas a nivel de módulo: las verificaciones no definen funciones adentro
// (jest/no-standalone-expect pierde el rastro con ellas).
const seqsDe = (b: unknown): unknown[] => items(b).map((m) => m.seq);
const idsDe = (b: unknown): unknown[] => items(b).map((m) => m.id);
const hayNotasInternas = (b: unknown): boolean =>
  items(b).some((m) => m.visibility === 'internal');
const seqsDeLaCita = (hilo: unknown): unknown[] => {
  const cita = items(hilo).find((m) => m.kind === 'quoted_excerpt');
  return (
    ((cita?.payload as Cuerpo | undefined)?.items as Cuerpo[] | undefined) ?? []
  ).map((i) => i.seq);
};
const ticketsCitadosEntre = (
  chat: unknown,
  desde: number,
  hasta: number,
): unknown[] =>
  items(chat)
    .filter((m) => (m.seq as number) >= desde && (m.seq as number) <= hasta)
    .map((m) => (m.citedInTickets as Cuerpo[]).map((x) => x.number));
const sistemasDe = (b: unknown): unknown[] =>
  items(b)
    .filter((m) => m.kind === 'system')
    .map((m) => m.systemCode);
const numerosDe = (b: unknown): unknown[] => items(b).map((t) => t.number);
const ultimo = (b: unknown): Cuerpo | undefined => items(b).at(-1);

describe('Matriz HTTP: chat con la plataforma y tickets (CH1, e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;
  const ds = () => env.app.get(DataSource);

  const ok = async (
    metodo: 'get' | 'post' | 'patch' | 'put' | 'delete',
    ruta: string,
    actor: string,
    body?: object,
  ): Promise<Cuerpo> => {
    const r = await llamar(ctx, metodo, ruta, actor, body);
    expect({ ruta, estado: r.status < 300, cuerpo: r.body as unknown }).toEqual(
      expect.objectContaining({ estado: true }),
    );
    return (r.body ?? {}) as Cuerpo;
  };

  /** Escribe `n` mensajes alternando empresa y plataforma en el chat de la empresa. */
  const conversar = async (empresa: 'adminA' | 'adminB', n: number) => {
    const primero = await ok(
      'post',
      '/v2/company/platform-chat/messages',
      empresa,
      mensaje('Arranco'),
    );
    const chat = primero.conversationId as string;
    for (let i = 2; i <= n; i += 1) {
      if (i % 2 === 0) {
        await ok(
          'post',
          `/v2/platform/chats/${chat}/messages`,
          'super',
          mensaje(`Respuesta ${i}`),
        );
      } else {
        await ok(
          'post',
          '/v2/company/platform-chat/messages',
          empresa,
          mensaje(`Sigo ${i}`),
        );
      }
    }
    return chat;
  };

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const e = await sembrarEscenario(env.app);
    ctx = {
      ...e,
      env,
      chatA: '',
      chatB: '',
      ticketA: '',
      ticketB: '',
      p: {},
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    ctx.chatA = await conversar('adminA', 10);
    ctx.chatB = await conversar('adminB', 2);
    ctx.ticketA = (
      await ok('post', '/v2/company/tickets', 'adminA', ticketNuevo())
    ).id as string;
    ctx.ticketB = (
      await ok('post', '/v2/company/tickets', 'adminB', ticketNuevo())
    ).id as string;
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  // ================================================= Lado de la empresa (C1a)
  const abierto = endpoint<Ctx>(
    'get',
    '/v2/company/platform-chat',
    '/v2/company/platform-chat',
  );
  const enviar = endpoint<Ctx>(
    'post',
    '/v2/company/platform-chat/messages',
    '/v2/company/platform-chat/messages',
  );
  const mensajesEmpresa = endpoint<Ctx>(
    'get',
    '/v2/company/platform-chat/{conversationId}/messages',
    (c) => `/v2/company/platform-chat/${c.chatA}/messages`,
  );
  const leerEmpresa = endpoint<Ctx>(
    'post',
    '/v2/company/platform-chat/{conversationId}/read',
    (c) => `/v2/company/platform-chat/${c.chatA}/read`,
  );
  const ticketDesdeChat = endpoint<Ctx>(
    'post',
    '/v2/company/platform-chat/{conversationId}/tickets',
    (c) => `/v2/company/platform-chat/${c.chatA}/tickets`,
  );
  const desdeChat = (extra: object = {}) => ({
    category: 'technical',
    priority: 'high',
    subject: 'No anda el push',
    fromSeq: 3,
    toSeq: 7,
    ...extra,
  });

  const casosEmpresaChat: Array<Caso<Ctx>> = [
    abierto('sin token', undefined, 401),
    abierto('cliente', 'clienteA', 403),
    abierto('super admin sin sesión (alcance de empresa)', 'super', 403),
    abierto(
      'admin de A: su chat, con los tickets que salieron de él',
      'adminA',
      200,
      {
        verificar: (b, c) => {
          expect((b as { conversation: Cuerpo }).conversation).toMatchObject({
            id: c.chatA,
            channel: 'platform_chat',
            counterpart: { party: 'platform' },
            canWrite: true,
          });
          expect(
            (b as { conversation: Cuerpo }).conversation,
          ).not.toHaveProperty('assignedTo');
        },
      },
    ),
    enviar('sin token', undefined, 401, { body: mensaje() }),
    enviar('texto vacío', 'adminA', 400, {
      body: { clientMessageId: randomUUID(), body: '   ' },
    }),
    enviar('sin clientMessageId', 'adminA', 400, { body: { body: 'Hola' } }),
    enviar('más de 2000 caracteres', 'adminA', 400, {
      body: mensaje('x'.repeat(2001)),
    }),
    enviar('admin sin soporte.gestionar', 'adminA2', 403, {
      antes: async (c) => {
        const rol = await ok('post', '/v2/staff-roles', 'adminA', {
          name: `Lector ${randomUUID().slice(0, 6)}`,
          permissions: ['soporte.ver'],
        });
        await ok(
          'put',
          `/v2/admins/${c.adminA2.adminId}/staff-role`,
          'adminA',
          {
            staffRoleId: rol.staffRoleId,
          },
        );
      },
      body: mensaje(),
      code: 'PERMISSION_DENIED',
    }),
    enviar(
      'reintento con el mismo clientMessageId → 200 y el mismo seq',
      'adminA',
      200,
      {
        antes: async (c) => {
          const m = mensaje('Una vez');
          c.p.cmid = m.clientMessageId;
          c.p.seq = String(
            (
              await ok(
                'post',
                '/v2/company/platform-chat/messages',
                'adminA',
                m,
              )
            ).seq,
          );
        },
        body: (c) => ({ clientMessageId: c.p.cmid, body: 'Una vez' }),
        verificar: (b, c) => {
          expect((b as Cuerpo).seq).toBe(Number(c.p.seq));
        },
      },
    ),
    mensajesEmpresa('sin token', undefined, 401),
    mensajesEmpresa('id mal formado', 'adminA', 400, {
      ruta: '/v2/company/platform-chat/xx/messages',
      code: 'INVALID_ID',
    }),
    mensajesEmpresa('afterSeq y beforeSeq juntos', 'adminA', 400, {
      ruta: (c) =>
        `/v2/company/platform-chat/${c.chatA}/messages?afterSeq=1&beforeSeq=5`,
    }),
    mensajesEmpresa(
      'el chat de A pedido por el admin de B → 404',
      'adminB',
      404,
    ),
    mensajesEmpresa('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/company/platform-chat/${c.inexistente}/messages`,
    }),
    mensajesEmpresa(
      'admin de A, después del 2: en orden de seq',
      'adminA',
      200,
      {
        ruta: (c) =>
          `/v2/company/platform-chat/${c.chatA}/messages?afterSeq=2&limit=3`,
        verificar: (b) => {
          expect(seqsDe(b)).toEqual([3, 4, 5]);
          expect((b as Cuerpo).hasMore).toBe(true);
        },
      },
    ),
    leerEmpresa('sin token', undefined, 401, { body: { seq: 1 } }),
    leerEmpresa('número negativo', 'adminA', 400, { body: { seq: -1 } }),
    leerEmpresa('el chat de A por el admin de B → 404', 'adminB', 404, {
      body: { seq: 1 },
    }),
    leerEmpresa('admin de A', 'adminA', 204, { body: { seq: 4 } }),
    ticketDesdeChat('sin token', undefined, 401, { body: desdeChat() }),
    ticketDesdeChat('rango 3–900 → TICKET_EXCERPT_INVALID', 'adminA', 400, {
      body: desdeChat({ toSeq: 900 }),
      code: 'TICKET_EXCERPT_INVALID',
    }),
    ticketDesdeChat('rango invertido', 'adminA', 400, {
      body: desdeChat({ fromSeq: 7, toSeq: 3 }),
      code: 'TICKET_EXCERPT_INVALID',
    }),
    ticketDesdeChat('asunto corto', 'adminA', 400, {
      body: desdeChat({ subject: 'x' }),
    }),
    ticketDesdeChat('el chat de A desde B → 404', 'adminB', 404, {
      body: desdeChat(),
    }),
    ticketDesdeChat(
      'mensajes 3 a 7: hilo propio con la cita, ticket_opened en el chat y citedInTickets',
      'adminA',
      201,
      {
        body: desdeChat(),
        verificar: async (b, c) => {
          const t = b as Cuerpo;
          expect(t).toMatchObject({
            status: 'new',
            origin: { conversationId: c.chatA, fromSeq: 3, toSeq: 7 },
          });
          const hilo = await ok(
            'get',
            `/v2/company/tickets/${t.id as string}/messages`,
            'adminA',
          );
          expect(seqsDeLaCita(hilo)).toEqual([3, 4, 5, 6, 7]);
          const chat = await ok(
            'get',
            `/v2/company/platform-chat/${c.chatA}/messages?limit=100`,
            'adminA',
          );
          expect(ultimo(chat)).toMatchObject({
            kind: 'system',
            systemCode: 'ticket_opened',
            payload: { number: t.number },
          });
          expect(ticketsCitadosEntre(chat, 3, 7)).toEqual(
            Array(5).fill([t.number]),
          );
        },
      },
    ),
  ];
  correrMatriz('Empresa: chat con la plataforma', ver, casosEmpresaChat);

  // ================================================= Lado de la empresa (C1b)
  const listarTickets = endpoint<Ctx>(
    'get',
    '/v2/company/tickets',
    '/v2/company/tickets',
  );
  const crearTicket = endpoint<Ctx>(
    'post',
    '/v2/company/tickets',
    '/v2/company/tickets',
  );
  const fichaTicket = endpoint<Ctx>(
    'get',
    '/v2/company/tickets/{id}',
    (c) => `/v2/company/tickets/${c.ticketA}`,
  );
  const hiloTicket = endpoint<Ctx>(
    'get',
    '/v2/company/tickets/{id}/messages',
    (c) => `/v2/company/tickets/${c.ticketA}/messages`,
  );
  const responderTicket = endpoint<Ctx>(
    'post',
    '/v2/company/tickets/{id}/messages',
    (c) => `/v2/company/tickets/${c.ticketA}/messages`,
  );
  const citar = endpoint<Ctx>(
    'post',
    '/v2/company/tickets/{id}/excerpts',
    (c) => `/v2/company/tickets/${c.ticketA}/excerpts`,
  );
  const confirmar = endpoint<Ctx>(
    'post',
    '/v2/company/tickets/{id}/confirm',
    (c) => `/v2/company/tickets/${c.ticketA}/confirm`,
  );

  /** Un ticket de A llevado a un estado por la plataforma. */
  const ticketEn = async (
    estado: 'resolved' | 'closed' | 'waiting_company',
  ) => {
    const t = await ok('post', '/v2/company/tickets', 'adminA', ticketNuevo());
    const id = t.id as string;
    await ok(
      'post',
      `/v2/platform/tickets/${id}/messages`,
      'super',
      mensaje('Lo miramos'),
    );
    if (estado !== 'waiting_company') {
      await ok('patch', `/v2/platform/tickets/${id}`, 'super', {
        status: 'resolved',
      });
    }
    if (estado === 'closed') {
      // El equipo no cierra a mano (§4.2.2): lo cierra la empresa al confirmar.
      await ok('post', `/v2/company/tickets/${id}/confirm`, 'adminA', {});
    }
    return id;
  };

  const casosEmpresaTickets: Array<Caso<Ctx>> = [
    listarTickets('sin token', undefined, 401),
    listarTickets('estado desconocido', 'adminA', 400, {
      ruta: '/v2/company/tickets?status=todo',
    }),
    listarTickets('admin de B no ve los de A', 'adminB', 200, {
      verificar: (b, c) => {
        expect(idsDe(b)).not.toContain(c.ticketA);
      },
    }),
    crearTicket('sin token', undefined, 401, { body: ticketNuevo() }),
    crearTicket('categoría desconocida', 'adminA', 400, {
      body: ticketNuevo({ category: 'x' }),
    }),
    crearTicket('asunto de 4 letras', 'adminA', 400, {
      body: ticketNuevo({ subject: 'abcd' }),
    }),
    crearTicket('primer mensaje vacío', 'adminA', 400, {
      body: ticketNuevo({
        firstMessage: { clientMessageId: randomUUID(), body: '' },
      }),
    }),
    crearTicket(
      'reintento con el mismo primer mensaje → 200 y el mismo ticket',
      'adminA',
      200,
      {
        antes: async (c) => {
          const cuerpo = ticketNuevo();
          c.p.cuerpoTicket = JSON.stringify(cuerpo);
          c.p.ticketRepetido = (
            await ok('post', '/v2/company/tickets', 'adminA', cuerpo)
          ).id as string;
        },
        body: (c) => JSON.parse(c.p.cuerpoTicket) as object,
        verificar: (b, c) => {
          expect((b as Cuerpo).id).toBe(c.p.ticketRepetido);
        },
      },
    ),
    fichaTicket('ticket de A por el admin de B → 404', 'adminB', 404),
    fichaTicket('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/company/tickets/${c.inexistente}`,
    }),
    fichaTicket('admin de A: sin assignedTo', 'adminA', 200, {
      verificar: (b) => {
        expect(b).not.toHaveProperty('assignedTo');
        expect((b as Cuerpo).number).toMatch(/^T-\d{6}$/);
      },
    }),
    hiloTicket(
      'la nota interna de la plataforma no le llega a la empresa',
      'adminA',
      200,
      {
        antes: async (c) => {
          await ok(
            'post',
            `/v2/platform/tickets/${c.ticketA}/messages`,
            'super',
            {
              ...mensaje('Nota: revisar la base'),
              visibility: 'internal',
            },
          );
        },
        verificar: (b) => {
          expect(hayNotasInternas(b)).toBe(false);
          expect(JSON.stringify(b)).not.toContain('revisar la base');
        },
      },
    ),
    hiloTicket('ticket de A por el admin de B → 404', 'adminB', 404),
    responderTicket('sin token', undefined, 401, { body: mensaje() }),
    responderTicket('ticket de A por el admin de B → 404', 'adminB', 404, {
      body: mensaje(),
    }),
    responderTicket(
      'esperando a la empresa: responde y vuelve a open',
      'adminA',
      201,
      {
        antes: async (c) => {
          c.p.esperando = await ticketEn('waiting_company');
        },
        ruta: (c) => `/v2/company/tickets/${c.p.esperando}/messages`,
        body: mensaje('Les mando la captura'),
        verificar: async (_b, c) => {
          const t = await ok(
            'get',
            `/v2/company/tickets/${c.p.esperando}`,
            'adminA',
          );
          expect(t.status).toBe('open');
        },
      },
    ),
    responderTicket('ticket cerrado → TICKET_CLOSED', 'adminA', 409, {
      antes: async (c) => {
        c.p.cerrado = await ticketEn('closed');
      },
      ruta: (c) => `/v2/company/tickets/${c.p.cerrado}/messages`,
      body: mensaje(),
      code: 'TICKET_CLOSED',
    }),
    citar('el chat de B en un ticket de A → 404', 'adminA', 404, {
      body: (c) => ({ sourceConversationId: c.chatB, fromSeq: 1, toSeq: 1 }),
    }),
    citar('rango fuera del chat', 'adminA', 400, {
      body: (c) => ({ sourceConversationId: c.chatA, fromSeq: 1, toSeq: 900 }),
      code: 'TICKET_EXCERPT_INVALID',
    }),
    citar('admin de A: cita nueva en el hilo', 'adminA', 201, {
      body: (c) => ({ sourceConversationId: c.chatA, fromSeq: 1, toSeq: 2 }),
      verificar: (b) => {
        expect(b).toMatchObject({ kind: 'quoted_excerpt' });
      },
    }),
    confirmar('no resuelto → TICKET_NOT_RESOLVED', 'adminA', 409, {
      body: {},
      code: 'TICKET_NOT_RESOLVED',
    }),
    confirmar('calificación 6', 'adminA', 400, { body: { satisfaction: 6 } }),
    confirmar('resuelto: se cierra con la calificación', 'adminA', 200, {
      antes: async (c) => {
        c.p.resuelto = await ticketEn('resolved');
      },
      ruta: (c) => `/v2/company/tickets/${c.p.resuelto}/confirm`,
      body: { satisfaction: 5 },
      verificar: (b) => {
        expect(b).toMatchObject({ status: 'closed', satisfaction: 5 });
      },
    }),
  ];
  correrMatriz('Empresa: tickets', ver, casosEmpresaTickets);

  // ================================================= Lado de la plataforma
  const chats = endpoint<Ctx>(
    'get',
    '/v2/platform/chats',
    '/v2/platform/chats',
  );
  const escribirle = endpoint<Ctx>(
    'post',
    '/v2/platform/chats',
    '/v2/platform/chats',
  );
  const tomar = endpoint<Ctx>(
    'post',
    '/v2/platform/chats/{id}/take',
    (c) => `/v2/platform/chats/${c.chatB}/take`,
  );
  const cerrar = endpoint<Ctx>(
    'post',
    '/v2/platform/chats/{id}/close',
    (c) => `/v2/platform/chats/${c.chatB}/close`,
  );
  const tickets = endpoint<Ctx>(
    'get',
    '/v2/platform/tickets',
    '/v2/platform/tickets',
  );
  const patch = endpoint<Ctx>(
    'patch',
    '/v2/platform/tickets/{id}',
    (c) => `/v2/platform/tickets/${c.ticketB}`,
  );
  const notaEnChat = endpoint<Ctx>(
    'post',
    '/v2/platform/chats/{id}/messages',
    (c) => `/v2/platform/chats/${c.chatA}/messages`,
  );

  const casosPlataforma: Array<Caso<Ctx>> = [
    chats('sin token', undefined, 401),
    chats('admin de empresa', 'adminA', 403),
    chats('super admin: el chat de A aparece en la cola', 'super', 200, {
      verificar: (b, c) => {
        expect(idsDe(b)).toEqual(expect.arrayContaining([c.chatA, c.chatB]));
        expect(b).toHaveProperty('counts.waiting');
      },
    }),
    chats('assigned mal formado', 'super', 400, {
      ruta: '/v2/platform/chats?assigned=alguien',
    }),
    escribirle('empresa inexistente', 'super', 404, {
      body: (c) => ({ distributorId: c.inexistente, firstMessage: mensaje() }),
    }),
    escribirle('admin de empresa', 'adminA', 403, {
      body: (c) => ({ distributorId: c.distA.id, firstMessage: mensaje() }),
    }),
    notaEnChat(
      'una nota interna en el chat → 400 (el campo no existe fuera de los tickets)',
      'super',
      400,
      {
        body: { ...mensaje('Hola'), visibility: 'internal' },
      },
    ),
    tomar('inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/chats/${c.inexistente}/take`,
    }),
    tomar('super admin lo toma', 'super', 200, {
      verificar: (b, c) => {
        expect((b as Cuerpo).assignedTo).toMatchObject({
          userId: c.superAdmin.userId,
        });
      },
    }),
    cerrar(
      'cerrar el chat no cambia los tickets que salieron de él',
      'super',
      200,
      {
        antes: async (c) => {
          c.p.desdeB = (
            await ok('post', `/v2/platform/chats/${c.chatB}/tickets`, 'super', {
              category: 'other',
              priority: 'low',
              subject: 'Seguimiento del chat',
              fromSeq: 1,
              toSeq: 1,
            })
          ).id as string;
        },
        verificar: async (b, c) => {
          expect(b).toMatchObject({ status: 'closed', closedReason: 'manual' });
          const t = await ok(
            'get',
            `/v2/platform/tickets/${c.p.desdeB}`,
            'super',
          );
          expect(t.status).toBe('waiting_company');
        },
      },
    ),
    tickets('admin de empresa', 'adminA', 403),
    tickets('super admin: con conteos', 'super', 200, {
      verificar: (b) => {
        expect(b).toHaveProperty('counts.overdue');
      },
    }),
    tickets('filtro por número', 'super', 200, {
      ruta: '/v2/platform/tickets?q=T-000001',
      verificar: (b) => {
        expect(numerosDe(b)).toEqual(['T-000001']);
      },
    }),
    patch('sin cambios', 'super', 400, { body: {} }),
    patch('transición inválida new → closed', 'super', 400, {
      body: { status: 'closed' },
      code: 'TICKET_INVALID_TRANSITION',
    }),
    patch('asignar a un admin de empresa', 'super', 400, {
      body: (c) => ({ assignedTo: c.adminA.userId }),
      code: 'TICKET_ASSIGNEE_INVALID',
    }),
    patch('admin de empresa', 'adminB', 403, { body: { priority: 'high' } }),
    patch('asignarse uno nuevo lo pasa a open', 'super', 200, {
      body: (c) => ({ assignedTo: c.superAdmin.userId }),
      verificar: (b) => {
        expect(b).toMatchObject({ status: 'open' });
      },
    }),
  ];
  correrMatriz('Plataforma: chats y tickets', ver, casosPlataforma);

  // ================================== Contadores (relevamiento B3) y D-C29
  const resumenEmpresa = endpoint<Ctx>(
    'get',
    '/v2/company/support/summary',
    '/v2/company/support/summary',
  );
  const resumenPlataforma = endpoint<Ctx>(
    'get',
    '/v2/platform/support/summary',
    '/v2/platform/support/summary',
  );
  const casosResumen: Array<Caso<Ctx>> = [
    resumenEmpresa('sin token', undefined, 401),
    resumenEmpresa('cliente', 'clienteA', 403),
    resumenEmpresa('super admin sin sesión', 'super', 403),
    resumenEmpresa('admin de A: el total suma chat y tickets', 'adminA', 200, {
      verificar: (b) => {
        const r = b as {
          chatUnread: number;
          ticketsUnread: number;
          total: number;
        };
        expect(r.total).toBe(r.chatUnread + r.ticketsUnread);
      },
    }),
    resumenPlataforma('sin token', undefined, 401),
    resumenPlataforma('admin de empresa', 'adminA', 403),
    resumenPlataforma('super admin', 'super', 200, {
      verificar: (b) => {
        expect(b).toEqual({
          chatsUnread: expect.any(Number) as unknown,
          chatsUnassigned: expect.any(Number) as unknown,
          ticketsUnread: expect.any(Number) as unknown,
          ticketsUnassigned: expect.any(Number) as unknown,
          total: expect.any(Number) as unknown,
        });
      },
    }),
    listarTickets(
      'B3: cada ticket trae unreadCount y su último mensaje',
      'adminA',
      200,
      {
        antes: async (c) => {
          await ok(
            'post',
            `/v2/platform/tickets/${c.ticketA}/messages`,
            'super',
            mensaje('Respuesta nueva'),
          );
        },
        verificar: (b, c) => {
          expect(items(b).find((t) => t.id === c.ticketA)).toMatchObject({
            unreadCount: expect.any(Number) as unknown,
            lastMessage: { party: 'platform', preview: 'Respuesta nueva' },
          });
        },
      },
    ),
  ];
  correrMatriz('Contadores del soporte', ver, casosResumen);

  // ============================================ Recorridos de la aceptación
  describe('aceptación CH1', () => {
    it('50 envíos concurrentes al mismo chat → seq consecutivos sin huecos', async () => {
      const chat = await conversar('adminB', 1);
      const antes = (await ok('get', `/v2/platform/chats/${chat}`, 'super'))
        .lastMessage as Cuerpo;
      const respuestas = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          llamar(
            ctx,
            'post',
            '/v2/company/platform-chat/messages',
            'adminB',
            mensaje(`m${i}`),
          ),
        ),
      );
      const seqs = respuestas
        .map((r) => (r.body as Cuerpo).seq as number)
        .sort((a, b) => a - b);
      const desde = (antes.seq as number) + 1;
      expect({
        estados: [...new Set(respuestas.map((r) => r.status))],
        seqs,
      }).toEqual({
        estados: [201],
        seqs: Array.from({ length: 50 }, (_, i) => desde + i),
      });
    }, 120000);

    it('estados independientes: el chat cerrado por inactividad no cambia el ticket; cerrar el ticket no cierra el chat', async () => {
      const chat = await conversar('adminA', 1);
      const t = await ok(
        'post',
        `/v2/company/platform-chat/${chat}/tickets`,
        'adminA',
        {
          category: 'data',
          priority: 'low',
          subject: 'Datos del CUIT',
          fromSeq: 1,
          toSeq: 1,
        },
      );
      await ds().query(
        `UPDATE "conversation" SET "last_message_at" = now() - interval '25 hours' WHERE "conversation_id" = $1`,
        [chat],
      );
      await env.app.get(SupportHousekeepingCron).barrer(new Date());
      const ficha = await ok('get', `/v2/platform/chats/${chat}`, 'super');
      const ticket = await ok(
        'get',
        `/v2/platform/tickets/${t.id as string}`,
        'super',
      );
      expect({ chat: ficha.closedReason, ticket: ticket.status }).toEqual({
        chat: 'inactivity',
        ticket: 'new',
      });

      // Un mensaje nuevo en el chat abre otro y no entra al hilo del ticket.
      const nuevo = await ok(
        'post',
        '/v2/company/platform-chat/messages',
        'adminA',
        mensaje('Otra cosa'),
      );
      expect(nuevo.conversationId).not.toBe(chat);
      const hilo = await ok(
        'get',
        `/v2/company/tickets/${t.id as string}/messages`,
        'adminA',
      );
      expect(JSON.stringify(hilo)).not.toContain('Otra cosa');

      // Resolver y cerrar el ticket no cierra el chat abierto.
      await ok(
        'post',
        `/v2/platform/tickets/${t.id as string}/messages`,
        'super',
        mensaje('Listo'),
      );
      await ok('patch', `/v2/platform/tickets/${t.id as string}`, 'super', {
        status: 'resolved',
      });
      await ok(
        'post',
        `/v2/company/tickets/${t.id as string}/confirm`,
        'adminA',
        {},
      );
      const abierto = await ok('get', '/v2/company/platform-chat', 'adminA');
      expect((abierto.conversation as Cuerpo).status).toBe('open');
    }, 120000);

    it('el trigger rechaza una transición inválida hecha por SQL', async () => {
      await expect(
        ds().query(
          `UPDATE "support_ticket" SET "status" = 'closed', "closed_at" = now() WHERE "ticket_id" = $1`,
          [ctx.ticketB],
        ),
      ).rejects.toMatchObject({
        constraint: 'CHK_support_ticket_transicion_de_estado',
      });
    });

    it('el texto del mensaje queda [oculto] en audit_detail', async () => {
      const m = await ok(
        'post',
        '/v2/company/platform-chat/messages',
        'adminA',
        mensaje('Dato privado 12345'),
      );
      const filas: Array<{ field: string; new_value: string | null }> =
        await ds().query(
          `SELECT d."field", d."new_value" FROM "audit" a JOIN "audit_detail" d ON d."audit_id" = a."audit_id"
          WHERE a."entity" = 'Message' AND a."record_id" = $1`,
          [m.id],
        );
      expect(filas.find((f) => f.field === 'body')?.new_value).toBe('[oculto]');
      expect(JSON.stringify(filas)).not.toContain('Dato privado');
    });

    it('D-C29 y B2: el primer mensaje en horario recibe el aviso automático, una vez, y no prende el contador', async () => {
      const empresa = 'adminB';
      // Cierra el chat abierto de B (si hay) para empezar una apertura nueva.
      const actual = await ok('get', '/v2/company/platform-chat', empresa);
      const abierto = actual.conversation as Cuerpo | null;
      if (abierto)
        await ok(
          'post',
          `/v2/platform/chats/${abierto.id as string}/close`,
          'super',
        );
      const primero = await ok(
        'post',
        '/v2/company/platform-chat/messages',
        empresa,
        mensaje('Hola'),
      );
      await ok(
        'post',
        '/v2/company/platform-chat/messages',
        empresa,
        mensaje('¿Hay alguien?'),
      );
      const hilo = await ok(
        'get',
        `/v2/company/platform-chat/${primero.conversationId as string}/messages`,
        empresa,
      );
      expect(sistemasDe(hilo)).toEqual(['received_ack']);
      const resumen = await ok('get', '/v2/company/support/summary', empresa);
      expect(resumen.chatUnread).toBe(0);
      const chat = await ok(
        'get',
        `/v2/platform/chats/${primero.conversationId as string}`,
        'super',
      );
      // Una sola vez por apertura: el segundo mensaje no lo repite.
      expect(chat.lastMessage).toMatchObject({ party: 'company' });
    });

    it('empresa suspendida: sigue usando el chat y los tickets', async () => {
      await ds().query(
        `UPDATE "distributor" SET "status" = 'suspended' WHERE "distributor_id" = $1`,
        [ctx.distB.id],
      );
      try {
        const r = await Promise.all([
          llamar(
            ctx,
            'post',
            '/v2/company/platform-chat/messages',
            'adminB',
            mensaje('Estamos suspendidos'),
          ),
          llamar(ctx, 'get', '/v2/company/tickets', 'adminB'),
          llamar(
            ctx,
            'post',
            `/v2/company/tickets/${ctx.ticketB}/messages`,
            'adminB',
            mensaje('¿Qué pasó?'),
          ),
        ]);
        expect(r.map((x) => x.status)).toEqual([201, 200, 201]);
      } finally {
        await ds().query(
          `UPDATE "distributor" SET "status" = 'active' WHERE "distributor_id" = $1`,
          [ctx.distB.id],
        );
      }
    });
  });
});
