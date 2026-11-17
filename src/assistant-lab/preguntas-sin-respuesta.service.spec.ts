import type { DataSource, EntityManager } from 'typeorm';
import type { AssistantFaqService } from '../assistant/assistant-faq.service';
import type { AssistantFaq } from '../assistant/entities/assistant-faq.entity';
import { Channel } from '../chat/domain/chat.enums';
import {
  idDelGrupo,
  MOTIVOS_SIN_RESPUESTA,
  preguntaNormalizada,
  TOPE_DE_MENSAJES_SIN_RESPUESTA,
} from './assistant-lab.dominio';
import { PreguntasSinRespuestaService } from './preguntas-sin-respuesta.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
/** Lunes 16/11/2026, 12:00 en Buenos Aires. */
const AHORA = new Date('2026-11-16T15:00:00Z');

/** Una traza que derivó con su mensaje, como las guarda la base. */
interface Traza {
  distributorId: string;
  channel: Channel;
  body: string;
  createdAt: Date;
  reason?: string;
  /** Con `requested`, la causa que dio el modelo. */
  cause?: string;
  model?: string | null;
  outcome?: string;
  redacted?: boolean;
}

interface Resolucion {
  distributor_id: string | null;
  channel: string;
  question_key: string;
  status: string;
  faq_id: string | null;
  resolved_by: string | null;
  resolved_at: Date;
}

const grupo = (texto: string) => idDelGrupo(preguntaNormalizada(texto)!);

/**
 * Una base en memoria que entiende el SQL del servicio: aplica a las trazas
 * los filtros que dice la consulta (canal, empresa si la filtra, motivos,
 * período, sin los retirados) para que el aislamiento se vea en el resultado
 * y no sólo en el texto del SQL.
 */
function armar(trazas: Traza[], resoluciones: Resolucion[] = []) {
  /** Cuántas filas había para cada página pedida (antes del LIMIT). */
  const paginas: number[] = [];
  /** Las preguntas de la base, por id (las dadas de baja no están). */
  const vigentes = new Map<string, AssistantFaq>();
  let creadas = 0;
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM "assistant_trace" t')) {
      const [channel, motivos, desde, hasta, , causas, desdeCursor, idCursor] =
        params as [
          string,
          string[],
          Date,
          Date,
          unknown,
          string[],
          Date | null,
          string | null,
        ];
      const empresa = sql.includes('t."distributor_id" = $5')
        ? (params[4] as string)
        : null;
      const filas = trazas
        .filter(
          (t) =>
            String(t.channel) === channel &&
            (empresa === null || t.distributorId === empresa) &&
            (t.outcome ?? 'handed_off') === 'handed_off' &&
            (t.model === undefined ? 'claude-haiku-5-5' : t.model) !== null &&
            (motivos.includes(t.reason ?? 'refusal') ||
              (t.reason === 'requested' && causas.includes(t.cause ?? ''))) &&
            t.createdAt >= desde &&
            t.createdAt < hasta &&
            !t.redacted,
        )
        .map((t) => ({
          trace_id: `traza-${String(trazas.indexOf(t)).padStart(6, '0')}`,
          body: t.body,
          created_at: t.createdAt,
        }))
        .sort(
          (x, y) =>
            y.created_at.getTime() - x.created_at.getTime() ||
            (y.trace_id < x.trace_id ? -1 : 1),
        )
        .filter(
          (f) =>
            desdeCursor === null ||
            f.created_at < desdeCursor ||
            (f.created_at.getTime() === desdeCursor.getTime() &&
              f.trace_id < (idCursor ?? '')),
        );
      paginas.push(filas.length);
      return Promise.resolve(filas.slice(0, TOPE_DE_MENSAJES_SIN_RESPUESTA));
    }
    if (
      sql.includes('SELECT "faq_id" FROM "assistant_unanswered_resolution"')
    ) {
      const [channel, id] = params as [string, string];
      const empresa = sql.includes('"distributor_id" IS NULL')
        ? null
        : (params[2] as string);
      return Promise.resolve(
        resoluciones
          .filter(
            (r) =>
              r.channel === channel &&
              r.distributor_id === empresa &&
              r.question_key === id &&
              r.status === 'resolved',
          )
          .map((r) => ({ faq_id: r.faq_id })),
      );
    }
    if (sql.includes('FROM "assistant_unanswered_resolution"')) {
      const [channel, ids] = params as [string, string[]];
      const empresa = sql.includes('"distributor_id" IS NULL')
        ? null
        : (params[2] as string);
      return Promise.resolve(
        resoluciones.filter(
          (r) =>
            r.channel === channel &&
            r.distributor_id === empresa &&
            ids.includes(r.question_key),
        ),
      );
    }
    return Promise.reject(new Error(`SQL inesperado: ${sql}`));
  });
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (!sql.startsWith('INSERT INTO "assistant_unanswered_resolution"')) {
        return Promise.reject(new Error(`SQL inesperado: ${sql}`));
      }
      const [distributor_id, channel, question_key, status, faq_id, by] =
        params as [
          string | null,
          string,
          string,
          string,
          string | null,
          string,
        ];
      const previa = resoluciones.find(
        (r) =>
          r.channel === channel &&
          r.distributor_id === distributor_id &&
          r.question_key === question_key,
      );
      const fila = {
        distributor_id,
        channel,
        question_key,
        status,
        faq_id,
        resolved_by: by,
        resolved_at: AHORA,
      };
      if (previa) Object.assign(previa, fila);
      else resoluciones.push(fila);
      return Promise.resolve([]);
    }),
  };
  const dataSource = {
    query,
    transaction: jest.fn((trabajo: (m: typeof manager) => Promise<unknown>) =>
      trabajo(manager),
    ),
  };
  const faqs = {
    crearBorrador: jest.fn(
      async (
        duenio: string | null,
        datos: { question: string; key?: string },
        actor: string | null,
        despues: (m: EntityManager, f: AssistantFaq) => Promise<void>,
      ) => {
        creadas += 1;
        const fila = {
          faqId: creadas === 1 ? 'faq-nueva' : `faq-nueva-${creadas}`,
          distributorId: duenio,
          question: datos.question,
          key: datos.key ?? null,
          answer: '',
          createdBy: actor,
        } as unknown as AssistantFaq;
        await despues(manager as unknown as EntityManager, fila);
        vigentes.set(fila.faqId, fila);
        return fila;
      },
    ),
    vigente: jest.fn((duenio: string | null, faqId: string) => {
      const f = vigentes.get(faqId);
      return Promise.resolve(f && f.distributorId === duenio ? f : null);
    }),
  };
  const servicio = new PreguntasSinRespuestaService(
    dataSource as unknown as DataSource,
    faqs as unknown as AssistantFaqService,
  );
  return { servicio, query, manager, faqs, resoluciones, vigentes, paginas };
}

const dia = (n: number) => new Date(AHORA.getTime() - n * 86_400_000);

const TRAZAS: Traza[] = [
  // Empresa A, sus clientes (C3).
  {
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    body: '¿Hacen envíos a Garupá?',
    createdAt: dia(1),
  },
  {
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    body: 'hacen envios a garupa??',
    createdAt: dia(3),
    reason: 'tool_rounds',
  },
  // De A, pero la IA no corrió (tope): no cuenta.
  {
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    body: '¿Aceptan cheques?',
    createdAt: dia(2),
    reason: 'monthly_limit',
    model: null,
  },
  // De A, anonimizado: no cuenta.
  {
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    body: 'Mi DNI es 30111222',
    createdAt: dia(2),
    redacted: true,
  },
  // De A, pero hace 40 días: fuera de los 30 por omisión.
  {
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    body: '¿Venden carbón?',
    createdAt: dia(40),
  },
  // De A, pero pidió pasar a una persona («quiero hablar con alguien»,
  // reclamo): no es «no supo».
  {
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    body: 'Quiero hablar con alguien por un reclamo',
    createdAt: dia(1),
    reason: 'requested',
  },
  // Empresa B, sus clientes: A nunca lo ve.
  {
    distributorId: B,
    channel: Channel.STAFF_CUSTOMER,
    body: '¿Tienen garrafas de 45 kg?',
    createdAt: dia(1),
  },
  // Soporte de la plataforma (C1), preguntado por A: sólo lo ve la plataforma.
  {
    distributorId: A,
    channel: Channel.PLATFORM_CHAT,
    body: '¿Cómo exporto las ventas?',
    createdAt: dia(1),
  },
];

describe('PreguntasSinRespuestaService', () => {
  describe('listar: aislamiento', () => {
    it('la empresa ve sólo lo que no supo contestar a SUS clientes, agrupado, en los últimos 30 días', async () => {
      const t = armar(TRAZAS);
      const r = await t.servicio.listar(A, undefined, undefined, AHORA);
      expect(r.from).toBe('2026-10-18');
      expect(r.to).toBe('2026-11-16');
      expect(r.truncated).toBe(false);
      expect(r.items).toEqual([
        {
          id: grupo('hacen envios a garupa'),
          question: '¿Hacen envíos a Garupá?',
          count: 2,
          firstSeenAt: dia(3),
          lastSeenAt: dia(1),
        },
      ]);
      const [sql, params = []] = t.query.mock.calls[0];
      expect(sql).toContain('t."distributor_id" = $5');
      expect(sql).toContain('m."distributor_id" = t."distributor_id"');
      expect(sql).toContain('m."redacted_at" IS NULL');
      expect(params[0]).toBe(Channel.STAFF_CUSTOMER);
      expect(params[1]).toEqual(MOTIVOS_SIN_RESPUESTA);
      expect(params[4]).toBe(A);
    });

    it('de requested cuenta lo que el modelo no sabía (no_info, low_confidence), no lo que pidió la persona ni los reclamos', async () => {
      const deA = (body: string, cause: string): Traza => ({
        distributorId: A,
        channel: Channel.STAFF_CUSTOMER,
        body,
        createdAt: dia(1),
        reason: 'requested',
        cause,
      });
      const t = armar([
        deA('¿Venden carbón?', 'no_info'),
        deA('¿Tienen garrafas de 45?', 'low_confidence'),
        deA('Quiero hablar con alguien', 'customer_asked'),
        deA('Me cobraron de más', 'complaint'),
        deA('¿Y la otra cosa?', 'other'),
      ]);
      const r = await t.servicio.listar(A, undefined, undefined, AHORA);
      expect(r.items.map((g) => g.question).sort()).toEqual(
        ['¿Tienen garrafas de 45?', '¿Venden carbón?'].sort(),
      );
      const [sql, params = []] = t.query.mock.calls[0];
      expect(sql).toContain(`t."handoff_cause" = ANY($6::varchar[])`);
      expect(params[5]).toEqual(['no_info', 'low_confidence']);
    });

    it('lo que derivó por pedido de pasar a una persona (requested) no cuenta: no se distingue de un reclamo', async () => {
      const t = armar(TRAZAS);
      const r = await t.servicio.listar(A, undefined, undefined, AHORA);
      expect(r.items.map((g) => g.question)).not.toContain(
        'Quiero hablar con alguien por un reclamo',
      );
      const [, params = []] = t.query.mock.calls[0];
      expect(params[1]).not.toContain('requested');
    });

    it('otra empresa no ve nada de A', async () => {
      const t = armar(TRAZAS);
      const r = await t.servicio.listar(B, undefined, undefined, AHORA);
      expect(r.items.map((g) => g.question)).toEqual([
        '¿Tienen garrafas de 45 kg?',
      ]);
    });

    it('la plataforma ve sólo su soporte (C1), nunca lo de las empresas con sus clientes', async () => {
      const t = armar(TRAZAS);
      const r = await t.servicio.listar(null, undefined, undefined, AHORA);
      expect(r.items.map((g) => g.question)).toEqual([
        '¿Cómo exporto las ventas?',
      ]);
      const [sql, params = []] = t.query.mock.calls[0];
      expect(sql).not.toContain('t."distributor_id" = $5');
      expect(sql).toContain('AND $5::uuid IS NULL');
      expect(params[4]).toBeNull();
      expect(params[0]).toBe(Channel.PLATFORM_CHAT);
      const [sqlDeResoluciones] = t.query.mock.calls[1];
      expect(sqlDeResoluciones).toContain('"distributor_id" IS NULL');
    });

    it('con período: sólo ese; inválido: 400', async () => {
      const t = armar(TRAZAS);
      const r = await t.servicio.listar(A, '2026-09-01', '2026-10-31', AHORA);
      expect(r.items.map((g) => g.question)).toEqual(['¿Venden carbón?']);
      await expect(
        t.servicio.listar(A, '2026-11-10', '2026-11-01', AHORA),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('sin mensajes no busca resoluciones; con el tope de mensajes avisa que hay más', async () => {
      const vacia = armar([]);
      await vacia.servicio.listar(A, undefined, undefined, AHORA);
      expect(vacia.query).toHaveBeenCalledTimes(1);
      const muchas = armar(
        Array.from({ length: TOPE_DE_MENSAJES_SIN_RESPUESTA }, (_, i) => ({
          distributorId: A,
          channel: Channel.STAFF_CUSTOMER,
          body: `¿Llegan al barrio ${i}?`,
          createdAt: new Date(AHORA.getTime() - (i + 1) * 60_000),
        })),
      );
      const r = await muchas.servicio.listar(A, undefined, undefined, AHORA);
      expect(r.truncated).toBe(true);
      expect(r.items).toHaveLength(100);
    });
  });

  describe('crear pregunta en borrador', () => {
    it('la empresa: borrador en SU base con el texto del grupo y el grupo resuelto (con la pregunta creada), juntos', async () => {
      const t = armar(TRAZAS);
      const id = grupo('hacen envios a garupa');
      const r0 = await t.servicio.crearPregunta(
        A,
        id,
        '¿Llegan a Garupá?',
        'admin-a',
        AHORA,
      );
      expect(r0.creada).toBe(true);
      expect(r0.faq).toMatchObject({ faqId: 'faq-nueva', answer: '' });
      expect(t.faqs.crearBorrador).toHaveBeenCalledWith(
        A,
        { question: '¿Llegan a Garupá?' },
        'admin-a',
        expect.any(Function),
      );
      expect(t.resoluciones).toEqual([
        expect.objectContaining({
          distributor_id: A,
          channel: Channel.STAFF_CUSTOMER,
          question_key: id,
          status: 'resolved',
          faq_id: 'faq-nueva',
          resolved_by: 'admin-a',
        }),
      ]);
      // Ya resuelto, no aparece más (hasta que se pregunte de nuevo).
      const r = await t.servicio.listar(A, undefined, undefined, AHORA);
      expect(r.items).toEqual([]);
      const [sql] = t.manager.query.mock.calls[0];
      expect(sql).toContain(
        `ON CONFLICT ("channel", COALESCE("distributor_id", '00000000-0000-0000-0000-000000000000'::uuid), "question_key")`,
      );
    });

    it('el grupo volvió y ya tenía su pregunta vigente: devuelve esa sin crear otra y lo vuelve a marcar resuelto', async () => {
      const id = grupo('hacen envios a garupa');
      const t = armar(TRAZAS);
      await t.servicio.crearPregunta(A, id, '¿Llegan a Garupá?', 'a', AHORA);
      // Se vuelve a preguntar después de resuelto.
      const nueva = {
        distributorId: A,
        channel: Channel.STAFF_CUSTOMER,
        body: 'hacen envíos a garupá???',
        createdAt: new Date(AHORA.getTime() + 60_000),
      };
      const despues = armar([...TRAZAS, nueva], t.resoluciones);
      t.vigentes.forEach((f, k) => despues.vigentes.set(k, f));
      const luego = new Date(AHORA.getTime() + 120_000);
      const r = await despues.servicio.crearPregunta(
        A,
        id,
        '¿Otra redacción?',
        'a2',
        luego,
      );
      expect(r).toMatchObject({ creada: false, faq: { faqId: 'faq-nueva' } });
      expect(despues.faqs.crearBorrador).not.toHaveBeenCalled();
      expect(despues.faqs.vigente).toHaveBeenCalledWith(A, 'faq-nueva');
      expect(t.resoluciones).toEqual([
        expect.objectContaining({
          question_key: id,
          status: 'resolved',
          faq_id: 'faq-nueva',
          resolved_by: 'a2',
        }),
      ]);
    });

    it('si la pregunta de antes ya no está vigente (se dio de baja), crea otra', async () => {
      const id = grupo('hacen envios a garupa');
      const t = armar(TRAZAS, [
        {
          distributor_id: A,
          channel: Channel.STAFF_CUSTOMER,
          question_key: id,
          status: 'resolved',
          faq_id: 'faq-borrada',
          resolved_by: 'a',
          resolved_at: new Date(AHORA.getTime() - 10 * 86_400_000),
        },
      ]);
      const r = await t.servicio.crearPregunta(A, id, '¿Llegan?', 'a', AHORA);
      expect(r.creada).toBe(true);
      expect(t.faqs.crearBorrador).toHaveBeenCalledTimes(1);
    });

    it('encuentra el grupo aunque no esté entre los 2.000 mensajes más nuevos (busca por páginas)', async () => {
      const recientes: Traza[] = Array.from(
        { length: TOPE_DE_MENSAJES_SIN_RESPUESTA + 5 },
        (_, i) => ({
          distributorId: A,
          channel: Channel.STAFF_CUSTOMER,
          body: `¿Llegan al barrio ${i}?`,
          createdAt: new Date(AHORA.getTime() - (i + 1) * 60_000),
        }),
      );
      const vieja: Traza = {
        distributorId: A,
        channel: Channel.STAFF_CUSTOMER,
        body: '¿Venden leña?',
        createdAt: dia(200),
      };
      const t = armar([...recientes, vieja]);
      // En el listado de 30 días no entra (sólo los 2.000 más nuevos)...
      const lista = await t.servicio.listar(A, undefined, undefined, AHORA);
      expect(lista.truncated).toBe(true);
      // ...pero se puede crear su pregunta: la busca en la página siguiente.
      await t.servicio.crearPregunta(
        A,
        grupo('venden lena'),
        '¿Venden leña?',
        'a',
        AHORA,
      );
      expect(t.faqs.crearBorrador).toHaveBeenCalledTimes(1);
      const deLaBusqueda = t.query.mock.calls.filter(
        ([sql, params]) =>
          sql.includes('FROM "assistant_trace" t') &&
          (params as unknown[])[6] !== null,
      );
      expect(deLaBusqueda).toHaveLength(1);
      expect((deLaBusqueda[0][1] as unknown[])[7]).toMatch(/^traza-/);
    });

    it('la búsqueda corta en la fecha de la resolución: lo anterior no cuenta', async () => {
      const id = grupo('hacen envios a garupa');
      const t = armar(TRAZAS, [
        {
          distributor_id: A,
          channel: Channel.STAFF_CUSTOMER,
          question_key: id,
          status: 'dismissed',
          faq_id: null,
          resolved_by: 'a',
          resolved_at: dia(0.5),
        },
      ]);
      await expect(
        t.servicio.descartar(A, id, 'a', AHORA),
      ).rejects.toMatchObject({ status: 404 });
      const [, params] = t.query.mock.calls.find(([sql]) =>
        sql.includes('FROM "assistant_trace" t'),
      ) as unknown as [string, unknown[]];
      expect(params[2]).toEqual(dia(0.5));
    });

    it('la plataforma: en su base, con la clave del borrador, y el grupo resuelto sin empresa', async () => {
      const t = armar(TRAZAS);
      const id = grupo('como exporto las ventas');
      await t.servicio.crearPregunta(
        null,
        id,
        '¿Cómo exporto las ventas?',
        'super',
        AHORA,
      );
      expect(t.faqs.crearBorrador).toHaveBeenCalledWith(
        null,
        {
          question: '¿Cómo exporto las ventas?',
          key: `sin_respuesta_${id.slice(0, 12)}`,
        },
        'super',
        expect.any(Function),
      );
      expect(t.resoluciones).toEqual([
        expect.objectContaining({
          distributor_id: null,
          channel: Channel.PLATFORM_CHAT,
        }),
      ]);
    });

    it('un grupo de otra empresa (o de la plataforma) es 404 y no crea nada', async () => {
      const t = armar(TRAZAS);
      for (const [duenio, texto] of [
        [B, 'hacen envios a garupa'],
        [A, 'como exporto las ventas'],
        [null, 'hacen envios a garupa'],
      ] as const) {
        await expect(
          t.servicio.crearPregunta(
            duenio,
            grupo(texto),
            '¿Y esto?',
            'x',
            AHORA,
          ),
        ).rejects.toMatchObject({
          status: 404,
          response: { code: 'ASSISTANT_UNANSWERED_NOT_FOUND' },
        });
      }
      expect(t.faqs.crearBorrador).not.toHaveBeenCalled();
    });

    it('un id mal formado es 400 INVALID_ID, sin consultar', async () => {
      const t = armar(TRAZAS);
      await expect(
        t.servicio.crearPregunta(A, 'no-es-un-id', '¿Y esto?', 'x', AHORA),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'INVALID_ID' },
      });
      expect(t.query).not.toHaveBeenCalled();
    });

    it('busca el grupo en el último año (no sólo en los 30 días)', async () => {
      const t = armar(TRAZAS);
      await t.servicio.crearPregunta(
        A,
        grupo('venden carbon'),
        '¿Venden carbón?',
        'x',
        AHORA,
      );
      expect(t.faqs.crearBorrador).toHaveBeenCalledTimes(1);
    });
  });

  describe('descartar', () => {
    it('marca el grupo descartado (sin pregunta) y deja de aparecer; si se vuelve a preguntar, vuelve', async () => {
      const t = armar(TRAZAS);
      const id = grupo('hacen envios a garupa');
      await t.servicio.descartar(A, id, 'admin-a', AHORA);
      expect(t.resoluciones).toEqual([
        expect.objectContaining({
          status: 'dismissed',
          faq_id: null,
          question_key: id,
        }),
      ]);
      expect(
        (await t.servicio.listar(A, undefined, undefined, AHORA)).items,
      ).toEqual([]);
      const despues = armar(
        [
          ...TRAZAS,
          {
            distributorId: A,
            channel: Channel.STAFF_CUSTOMER,
            body: 'Hacen envíos a Garupá?',
            createdAt: new Date(AHORA.getTime() + 60_000),
          },
        ],
        t.resoluciones,
      );
      const r = await despues.servicio.listar(
        A,
        undefined,
        undefined,
        new Date(AHORA.getTime() + 120_000),
      );
      expect(r.items).toEqual([
        expect.objectContaining({
          id,
          count: 1,
          question: 'Hacen envíos a Garupá?',
        }),
      ]);
    });

    it('un grupo ya descartado es 404', async () => {
      const t = armar(TRAZAS);
      const id = grupo('hacen envios a garupa');
      await t.servicio.descartar(A, id, 'admin-a', AHORA);
      await expect(
        t.servicio.descartar(A, id, 'admin-a', AHORA),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it('sin momento explícito usa el reloj', async () => {
    const t = armar([]);
    const r = await t.servicio.listar(A, undefined, undefined);
    expect(r.items).toEqual([]);
    expect(r.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const id = grupo('hacen envios a garupa');
    await expect(
      t.servicio.crearPregunta(A, id, '¿Y esto?', 'x'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(t.servicio.descartar(A, id, 'x')).rejects.toMatchObject({
      status: 404,
    });
  });
});
