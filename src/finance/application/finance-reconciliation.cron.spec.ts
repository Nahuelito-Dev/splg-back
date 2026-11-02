import { DataSource } from 'typeorm';
import { CommissionLedgerService } from '../../commission/application/commission-ledger.service';
import { CustomerLedgerService } from '../../customer-account/application/customer-ledger.service';
import { RedisService } from '../../redis/redis.service';
import { FinanceReconciliationCron } from './finance-reconciliation.cron';

describe('FinanceReconciliationCron.verificarSaldos', () => {
  const armar = (
    respuestas: Record<string, { p_desfasadas: number; p_detalle: unknown[] }>,
  ) => {
    const query = jest.fn((sql: string, params: string[] = []) => {
      if (sql.startsWith('CALL'))
        return Promise.resolve([respuestas[params[0]]]);
      return Promise.resolve(
        Object.keys(respuestas).map((distributor_id) => ({ distributor_id })),
      );
    });
    const cron = new FinanceReconciliationCron(
      { query } as unknown as DataSource,
      {} as CommissionLedgerService,
      {} as CustomerLedgerService,
      {} as RedisService,
    );
    return { cron, query };
  };

  it('llama al procedimiento una vez por distribuidora y suma las diferencias', async () => {
    const { cron, query } = armar({
      d1: {
        p_desfasadas: 2,
        p_detalle: [
          { tipo: 'caja', id: 'c1', saldo: '999.00', libro: '10.00' },
          { tipo: 'cuenta', id: 'a1', saldo: '5.00', libro: '0' },
        ],
      },
      d2: { p_desfasadas: 0, p_detalle: [] },
    });
    expect(await cron.verificarSaldos()).toBe(2);
    const llamadas = query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('CALL verificar_saldos_de_caja($1'),
    );
    expect(llamadas.map(([, p]) => p)).toEqual([['d1'], ['d2']]);
  });

  it('registra un aviso por cada saldo desfasado', async () => {
    const { cron } = armar({
      d1: {
        p_desfasadas: 1,
        p_detalle: [
          { tipo: 'caja', id: 'c1', saldo: '999.00', libro: '10.00' },
        ],
      },
    });
    const warn = jest
      .spyOn(
        (cron as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation();
    await cron.verificarSaldos();
    expect(warn).toHaveBeenCalledWith(
      'Caja c1: saldo 999.00 y el libro suma 10.00',
    );
  });

  it('si el procedimiento falla (ROLLBACK + RAISE) el error sube', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ distributor_id: 'd1' }])
      .mockRejectedValueOnce(new Error('verificar_saldos_de_caja falló'));
    const cron = new FinanceReconciliationCron(
      { query } as unknown as DataSource,
      {} as CommissionLedgerService,
      {} as CustomerLedgerService,
      {} as RedisService,
    );
    await expect(cron.verificarSaldos()).rejects.toThrow(/falló/);
  });
});
