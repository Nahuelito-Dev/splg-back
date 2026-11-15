import type { DataSource } from 'typeorm';
import { Channel, Party } from '../domain/chat.enums';
import {
  BandejaReadModel,
  condicionDeNoLeidoEnLaBandeja,
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
      { unassigned: '3', mine: '2', awaiting: '1', unread: '4' },
    ]);
    const r = await lectura.resumen(
      'dist-a',
      [Channel.STAFF_CUSTOMER],
      personal,
    );
    expect(r).toEqual({ unassigned: 3, mine: 2, awaitingHuman: 1, unread: 4 });
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

  it('sin fila, todo en cero', async () => {
    const { lectura } = base([]);
    expect(
      await lectura.resumen('dist-a', [Channel.STAFF_DRIVER], personal),
    ).toEqual({ unassigned: 0, mine: 0, awaitingHuman: 0, unread: 0 });
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
