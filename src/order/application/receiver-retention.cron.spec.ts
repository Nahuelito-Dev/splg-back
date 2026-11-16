import { DataSource } from 'typeorm';
import {
  PLAZO_DE_RECLAMO_DIAS,
  ReceiverRetentionCron,
} from './receiver-retention.cron';
import { RedisService } from '../../redis/redis.service';

describe('ReceiverRetentionCron (CU-128, paso 6)', () => {
  let cron: ReceiverRetentionCron;
  let query: jest.Mock;
  let withLock: jest.Mock;

  beforeEach(() => {
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('UPDATE')
          ? [[{ order_id: 'o1', distributor_id: 'd1' }], 1]
          : [],
      ),
    );
    withLock = jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) =>
      fn().then((valor) => ({ obtenido: true, valor })),
    );
    cron = new ReceiverRetentionCron(
      {
        transaction: (fn: (m: unknown) => unknown) => fn({ query }),
      } as unknown as DataSource,
      { withLock } as unknown as RedisService,
    );
  });

  it('anula los tres datos sólo de pedidos entregados o cancelados pasado el plazo', async () => {
    expect(await cron.barrer()).toBe(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"receiver_name" = NULL');
    expect(sql).toContain('"receiver_document" = NULL');
    expect(sql).toContain('"receiver_relationship" = NULL');
    expect(sql).toContain(`"status" IN ('delivered', 'cancelled')`);
    expect(sql).toContain('COALESCE(o."deliveredAt", o."updatedAt")');
    expect(params).toEqual([PLAZO_DE_RECLAMO_DIAS]);
  });

  it('no anula mientras haya un reclamo abierto sobre el pedido', async () => {
    await cron.barrer();
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"claims"');
    expect(sql).toContain(`IN ('pending', 'in_process')`);
  });

  it('deja asentada la anulación en la auditoría sin los datos', async () => {
    await cron.barrer();
    const auditoria = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO "audit"'),
    ) as [string, unknown[]];
    expect(auditoria[1][4]).toBe('Order');
    expect(String(auditoria[1][7])).not.toMatch(/\d{6,}/);
  });

  it('corre bajo el cerrojo y no barre si otra instancia lo tiene', async () => {
    await cron.anularVencidos();
    expect(withLock).toHaveBeenCalledWith(
      ReceiverRetentionCron.CERROJO,
      ReceiverRetentionCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    query.mockClear();
    withLock.mockResolvedValue({ obtenido: false });
    await cron.anularVencidos();
    expect(query).not.toHaveBeenCalled();
  });

  it('si el barrido falla no propaga el error', async () => {
    query.mockRejectedValue(new Error('base caída'));
    await expect(cron.anularVencidos()).resolves.toBeUndefined();
  });
});
