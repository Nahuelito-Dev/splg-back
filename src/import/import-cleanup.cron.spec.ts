import { FindOperator } from 'typeorm';

import { ImportJobStatus } from './domain/import.enums';
import { ImportCleanupCron } from './import-cleanup.cron';

describe('ImportCleanupCron', () => {
  it('borra sólo las no confirmadas que ya vencieron', async () => {
    const jobs = { delete: jest.fn().mockResolvedValue({ affected: 3 }) };
    const cron = new ImportCleanupCron(jobs as never);

    await expect(cron.borrarVencidas()).resolves.toBe(3);

    const [criterio] = jobs.delete.mock.calls[0] as [
      { status: FindOperator<string>; expiresAt: FindOperator<Date> },
    ];
    expect(criterio.status.type).toBe('not');
    expect(criterio.status.value).toBe(ImportJobStatus.CONFIRMED);
    expect(criterio.expiresAt.type).toBe('lessThan');
    expect(criterio.expiresAt.value).toBeInstanceOf(Date);
  });

  it('si el driver no informa cuántas borró, cuenta 0', async () => {
    const jobs = {
      delete: jest.fn().mockResolvedValue({ affected: undefined }),
    };
    await expect(
      new ImportCleanupCron(jobs as never).borrarVencidas(),
    ).resolves.toBe(0);
  });

  it('sin nada para borrar devuelve 0', async () => {
    const jobs = { delete: jest.fn().mockResolvedValue({ affected: 0 }) };
    await expect(
      new ImportCleanupCron(jobs as never).borrarVencidas(),
    ).resolves.toBe(0);
  });
});
