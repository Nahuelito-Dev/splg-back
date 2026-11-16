import type { DataSource } from 'typeorm';
import { Channel, Party } from '../domain/chat.enums';
import {
  BandejaReadModel,
  condicionDeNoLeidoEnLaBandeja,
  lecturaVisibleDeLaPunta,
  seqVisibleHasta,
} from './bandeja-read-model';

/** Base que anota cada consulta con sus parámetros y devuelve lo que se le diga. */
function base(respuesta: unknown[] = []) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const ds = {
    query: (sql: string, params: unknown[] = []) => {
      consultas.push({ sql: sql.replace(/\s+/g, ' '), params });
      return Promise.resolve(respuesta);
    },
  } as unknown as DataSource;
  return { consultas, lectura: new BandejaReadModel(ds) };
}

const personal = { party: Party.COMPANY, userId: 'adm-1' } as const;

describe('BandejaReadModel: mensajes atados (canEdit, D-C22)', () => {
  it('sin candidatos no consulta la base', async () => {
    const { consultas, lectura } = base();
    expect(await lectura.atados([])).toEqual(new Set());
    expect(consultas).toHaveLength(0);
  });

  it('en una sola consulta: pedido, reclamo posterior al mensaje, ticket y respuesta que lo cita (la regla del PATCH)', async () => {
    const { consultas, lectura } = base([{ message_id: 'm-2' }]);
    const atados = await lectura.atados(['m-1', 'm-2', 'm-1']);
    expect(atados).toEqual(new Set(['m-2']));
    expect(consultas).toHaveLength(1);
    const { sql, params } = consultas[0];
    expect(params).toEqual([['m-1', 'm-2']]);
    // Cualquiera de las cuatro ataduras alcanza (OR), como en el PATCH.
    expect(sql).toContain(
      `AND (c."subject_type" = 'order' ` +
        `OR EXISTS (SELECT 1 FROM "claims" cl WHERE cl."claim_id" = c."linked_claim_id" AND cl."createdAt" >= m."created_at") ` +
        `OR EXISTS (SELECT 1 FROM "support_ticket_message_link" l WHERE l."message_id" = m."message_id") ` +
        `OR EXISTS (SELECT 1 FROM "message" r WHERE r."conversation_id" = m."conversation_id" AND r."reply_to_seq" = m."seq"))`,
    );
  });
});

describe('BandejaReadModel: resumen de la bandeja (insignias)', () => {
  it('de las abiertas de esa empresa y esos canales, con lo sin leer de quien pide', async () => {
    const { consultas, lectura } = base([
      {
        unassigned: '3',
        mine: '2',
        awaiting: '1',
        unread: '4',
        attention: '5',
        mentions: '2',
      },
    ]);
    const r = await lectura.resumen(
      'dist-a',
      [Channel.STAFF_CUSTOMER],
      personal,
    );
    expect(r).toEqual({
      unassigned: 3,
      mine: 2,
      awaitingHuman: 1,
      unread: 4,
      attention: 5,
      mentions: 2,
    });
    expect(consultas).toHaveLength(1);
    const { sql, params } = consultas[0];
    expect(params).toEqual([
      'dist-a',
      [Channel.STAFF_CUSTOMER],
      'adm-1',
      Party.COMPANY,
    ]);
    expect(sql).toContain(`c."distributor_id" = $1`);
    expect(sql).toContain(`c."channel" = ANY($2::text[])`);
    expect(sql).toContain(`c."status" = 'open'`);
    expect(sql).toContain(`c."deleted_at" IS NULL`);
    expect(sql).toContain(`c."assigned_to_user_id" = $3`);
    expect(sql).toContain(`c."awaiting_human_since" IS NOT NULL`);
    expect(sql).toContain(`r."user_id" = $3`);
    expect(sql).toContain(
      condicionDeNoLeidoEnLaBandeja('$4').replace(/\s+/g, ' '),
    );
  });

  it('`unread` no cuenta las asignadas a otra persona; `attention` es sin asignar ∪ esperando ∪ sin leer, una vez por conversación; `mentions`, las sin leer de quien pide en esa empresa y esos canales', async () => {
    const { consultas, lectura } = base([]);
    await lectura.resumen('dist-a', [Channel.STAFF_CUSTOMER], personal);
    const { sql } = consultas[0];
    const sinLeer =
      `(c."assigned_to_user_id" IS NULL OR c."assigned_to_user_id" = $3) AND EXISTS ( ` +
      `SELECT 1 FROM "message" m WHERE m."conversation_id" = c."conversation_id" AND ` +
      condicionDeNoLeidoEnLaBandeja('$4').replace(/\s+/g, ' ');
    expect(sql).toContain(`count(*) FILTER (WHERE ${sinLeer})) AS unread`);
    expect(sql).toContain(
      `count(*) FILTER (WHERE c."assigned_to_user_id" IS NULL OR c."awaiting_human_since" IS NOT NULL OR (${sinLeer}))) AS attention`,
    );
    expect(sql).toContain(
      `WHERE mm."distributor_id" = $1 AND mm."mentioned_user_id" = $3 AND mm."read_at" IS NULL AND cm."channel" = ANY($2::text[])`,
    );
  });

  it('las notas internas nunca cuentan como sin leer (ni para la otra punta)', () => {
    expect(condicionDeNoLeidoEnLaBandeja('$3')).toContain(
      `m."visibility" = 'all'`,
    );
  });

  it('sin fila, todo en cero', async () => {
    const { lectura } = base([]);
    expect(
      await lectura.resumen('dist-a', [Channel.STAFF_DRIVER], personal),
    ).toEqual({
      unassigned: 0,
      mine: 0,
      awaitingHuman: 0,
      unread: 0,
      attention: 0,
      mentions: 0,
    });
  });

  it('el contador de cada conversación y el resumen cuentan lo mismo como «sin leer»', async () => {
    const { consultas, lectura } = base([]);
    await lectura.noLeidos(['conv-1'], personal);
    expect(consultas[0].sql).toContain(
      condicionDeNoLeidoEnLaBandeja('$3').replace(/\s+/g, ' '),
    );
    const c = condicionDeNoLeidoEnLaBandeja('$3');
    expect(c).toContain(`m."withdrawn_at" IS NULL`);
    expect(c).toContain(`m."kind" <> 'system'`);
    expect(c).toContain(`NOT ($3 = 'company' AND m."kind" = 'auto_reply')`);
  });
});

describe('BandejaReadModel: el personal de la empresa (para asignar)', () => {
  it('sólo de esa empresa, vigente (sin baja ni bloqueo) y con su rol vigente', async () => {
    const { consultas, lectura } = base([
      {
        user_id: 'adm-1',
        full_name: 'Lucía Gómez',
        photo_key: 'fotos/adm-1.jpg',
        is_system: false,
        permissions: ['mensajes.clientes'],
      },
      {
        user_id: 'adm-2',
        full_name: null,
        photo_key: null,
        is_system: true,
        permissions: null,
      },
    ]);
    expect(await lectura.personalDeLaEmpresa('dist-a')).toEqual([
      {
        userId: 'adm-1',
        fullName: 'Lucía Gómez',
        photoKey: 'fotos/adm-1.jpg',
        todos: false,
        permisos: ['mensajes.clientes'],
      },
      {
        userId: 'adm-2',
        fullName: 'Sin nombre',
        photoKey: null,
        todos: true,
        permisos: [],
      },
    ]);
    const { sql, params } = consultas[0];
    expect(params).toEqual(['dist-a']);
    expect(sql).toContain(`a."distributor_id" = $1`);
    expect(sql).toContain(`u."deletedAt" IS NULL AND u."blocked" = false`);
    expect(sql).toContain(`sr."deletedAt" IS NULL`);
  });
});

describe('BandejaReadModel: notas internas (4a) en la lista y en las menciones', () => {
  it('el último mensaje de cada conversación es el último visible: una nota nunca', async () => {
    const condiciones: string[] = [];
    const qb: Record<string, jest.Mock> = {};
    for (const f of ['distinctOn', 'orderBy', 'addOrderBy']) {
      qb[f] = jest.fn(() => qb);
    }
    qb.where = jest.fn((c: string) => (condiciones.push(c), qb));
    qb.andWhere = jest.fn((c: string) => (condiciones.push(c), qb));
    qb.getMany = jest.fn(() => Promise.resolve([]));
    const ds = {
      getRepository: () => ({ createQueryBuilder: () => qb }),
    } as unknown as DataSource;
    await new BandejaReadModel(ds).ultimos(['conv-1']);
    expect(condiciones).toContain("m.visibility = 'all'");
  });

  it('menciones: por nota, con el nombre de cada mencionado; sin notas no consulta', async () => {
    const vacio = base();
    expect(await vacio.lectura.menciones([])).toEqual(new Map());
    expect(vacio.consultas).toHaveLength(0);
    const { lectura, consultas } = base([
      { message_id: 'n-1', user_id: 'adm-2', full_name: 'Juan' },
      { message_id: 'n-1', user_id: 'adm-3', full_name: null },
    ]);
    expect(await lectura.menciones(['n-1', 'n-1'])).toEqual(
      new Map([
        [
          'n-1',
          [
            { userId: 'adm-2', fullName: 'Juan' },
            { userId: 'adm-3', fullName: 'Sin nombre' },
          ],
        ],
      ]),
    );
    expect(consultas[0].params).toEqual([['n-1']]);
  });

  it('menciones sin leer: sólo las de esa persona y sin leer, por conversación', async () => {
    const { lectura, consultas } = base([
      { conversation_id: 'conv-1', n: '2' },
    ]);
    expect(await lectura.mencionesSinLeer(['conv-1'], 'adm-2')).toEqual(
      new Map([['conv-1', 2]]),
    );
    expect(consultas[0].sql).toContain('"mentioned_user_id" = $2');
    expect(consultas[0].sql).toContain('"read_at" IS NULL');
    expect(consultas[0].params).toEqual([['conv-1'], 'adm-2']);
  });
});

describe('el «leído» de la otra punta, sobre mensajes visibles (4a)', () => {
  it('lecturaDeLaOtraParte cuenta hasta el último visible que no pasa de lo leído', async () => {
    const { lectura, consultas } = base([
      { conversation_id: 'conv-1', last_read_seq: '4' },
    ]);
    expect(
      await lectura.lecturaDeLaOtraParte(['conv-1'], Party.CUSTOMER),
    ).toEqual(new Map([['conv-1', 4]]));
    expect(consultas[0].sql).toContain(
      lecturaVisibleDeLaPunta('p').replace(/\s+/g, ' '),
    );
    const expresion = lecturaVisibleDeLaPunta('p');
    expect(expresion).toContain(`v."visibility" = 'all'`);
    expect(expresion).toContain(`v."seq" <= p."last_read_seq"`);
  });

  it('seqVisibleHasta: el último visible hasta ese número; sin ninguno, 0', async () => {
    const query = jest.fn(() => Promise.resolve([{ seq: '4' }]));
    expect(await seqVisibleHasta({ query } as never, 'conv-1', 5)).toBe(4);
    expect(
      (query.mock.calls[0] as unknown as [string, unknown[]])[0],
    ).toContain(`"visibility" = 'all'`);
    expect(
      await seqVisibleHasta(
        { query: jest.fn(() => Promise.resolve([{ seq: null }])) } as never,
        'conv-1',
        5,
      ),
    ).toBe(0);
  });
});
