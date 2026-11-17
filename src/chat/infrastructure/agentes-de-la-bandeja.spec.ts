import type { EntityManager } from 'typeorm';
import type { CanalDeLaBandeja } from '../domain/bandeja';
import { Channel } from '../domain/chat.enums';
import { AgentesDeLaBandeja } from './agentes-de-la-bandeja';

const A = 'dist-a';

function manager(filas: unknown[] = []) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(() =>
    Promise.resolve(filas),
  );
  return { m: { query } as unknown as EntityManager, query };
}

describe('AgentesDeLaBandeja (8b): lo que el reparto lee y escribe', () => {
  const repo = new AgentesDeLaBandeja();

  it('la cola: por canal y sólo las que se pueden dar (el lugar de ese canal), la más vieja primero, bloqueadas y salteando las tomadas; con su preferido', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(
      (sql, params) => {
        if (sql.includes('DISTINCT ON')) {
          return Promise.resolve([
            { conversation_id: 'c2', sender_user_id: 'ana' },
          ]);
        }
        return Promise.resolve(
          params?.[1] === 'staff_driver'
            ? [
                {
                  conversation_id: 'c2',
                  channel: 'staff_driver',
                  desde: '2026-11-17T10:00:00Z',
                },
              ]
            : [
                {
                  conversation_id: 'c1',
                  channel: 'staff_customer',
                  desde: '2026-11-17T11:00:00Z',
                },
              ],
        );
      },
    );
    const m = { query } as unknown as EntityManager;
    const cola = await repo.cola(
      m,
      A,
      new Map<CanalDeLaBandeja, number>([
        [Channel.STAFF_CUSTOMER, 2],
        [Channel.STAFF_DRIVER, 1],
      ]),
    );
    expect(cola).toEqual([
      { conversationId: 'c2', canal: 'staff_driver', preferido: 'ana' },
      { conversationId: 'c1', canal: 'staff_customer', preferido: null },
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/"distributor_id" = \$1 AND "channel" = \$2/);
    expect(sql).toMatch(/"assigned_to_user_id" IS NULL/);
    expect(sql).toMatch(/"awaiting_human_since" IS NOT NULL/);
    expect(sql).toMatch(/ORDER BY "awaiting_human_since" ASC/);
    expect(sql).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/);
    expect(params).toEqual([A, 'staff_customer', 2]);
    expect(query.mock.calls[1][1]).toEqual([A, 'staff_driver', 1]);
    // El preferido: la última del equipo que le escribió a la otra punta.
    expect(query.mock.calls[2][0]).toMatch(/"sender_party" = 'company'/);
    expect(query.mock.calls[2][0]).toMatch(/"visibility" = 'all'/);
  });

  it('un canal sin lugar ni se mira; sin lugar en ninguno, ni una consulta', async () => {
    const { m, query } = manager([]);
    expect(
      await repo.cola(
        m,
        A,
        new Map<CanalDeLaBandeja, number>([[Channel.STAFF_CUSTOMER, 0]]),
      ),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('las abiertas por persona: de la empresa, de los dos canales de la bandeja', async () => {
    const { m, query } = manager([
      { user_id: 'ana', n: '3' },
      { user_id: 'beto', n: 1 },
    ]);
    expect([...(await repo.abiertasPorPersona(m, A))]).toEqual([
      ['ana', 3],
      ['beto', 1],
    ]);
    expect(query.mock.calls[0][0]).toMatch(
      /"channel" IN \('staff_customer', 'staff_driver'\)/,
    );
  });

  it('lo guardado de cada persona, con las fechas y el tope como números', async () => {
    const { m } = manager([
      {
        user_id: 'ana',
        status: 'online',
        status_changed_at: '2026-11-17T12:00:00.000Z',
        max_open_override: '7',
        last_assigned_at: null,
      },
    ]);
    expect((await repo.ajustes(m, A)).get('ana')).toEqual({
      status: 'online',
      statusChangedAt: new Date('2026-11-17T12:00:00.000Z'),
      maxOpenOverride: 7,
      lastAssignedAt: null,
    });
  });

  it('estado y tope son un «alta o cambio» por empresa y persona; el estado sólo mueve su fecha si cambió', async () => {
    const { m, query } = manager();
    const ahora = new Date('2026-11-17T12:00:00Z');
    await repo.guardarEstado(m, A, 'ana', 'online', ahora);
    await repo.guardarTope(m, A, 'ana', null);
    await repo.marcarAsignacion(m, A, 'ana', ahora);
    const [estado, tope, marca] = query.mock.calls;
    expect(estado[0]).toMatch(
      /ON CONFLICT \("distributor_id", "user_id"\) DO UPDATE/,
    );
    expect(estado[0]).toMatch(
      /CASE WHEN "chat_agent_settings"."status" = EXCLUDED."status"/,
    );
    expect(estado[1]).toEqual([A, 'ana', 'online', ahora]);
    expect(tope[1]).toEqual([A, 'ana', null]);
    expect(marca[0]).toMatch(/SET "last_assigned_at" = \$3/);
  });

  it('las empresas vigentes con la función prendida', async () => {
    const { m, query } = manager([{ distributor_id: A }]);
    expect(await repo.empresasConLaFuncion(m)).toEqual([A]);
    expect(query.mock.calls[0][0]).toMatch(/"auto_assign_enabled"/);
    expect(query.mock.calls[0][0]).toMatch(/d."deletedAt" IS NULL/);
  });
});
