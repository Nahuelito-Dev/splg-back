import { Repository } from 'typeorm';
import { ModuleConfigService } from './module-config.service';
import {
  ConfigurableProcess,
  ModuleConfig,
} from './entities/module-config.entity';

describe('ModuleConfigService', () => {
  let service: ModuleConfigService;
  let repo: { findOne: jest.Mock; query: jest.Mock };

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      query: jest.fn().mockResolvedValue(undefined),
    };
    service = new ModuleConfigService(
      repo as unknown as Repository<ModuleConfig>,
    );
  });

  it('parametros: null si la distribuidora no configuró el proceso', async () => {
    expect(
      await service.parametros('d1', ConfigurableProcess.DISPATCH),
    ).toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { distributorId: 'd1', module: ConfigurableProcess.DISPATCH },
    });
  });

  it('parametros: devuelve los guardados', async () => {
    repo.findOne.mockResolvedValue({ params: { offerTtlSeconds: 60 } });
    expect(
      await service.parametros('d1', ConfigurableProcess.DISPATCH),
    ).toEqual({ offerTtlSeconds: 60 });
  });

  it('fila: devuelve la fila completa (quién y cuándo) o null', async () => {
    const fila = { params: {}, updatedByUserId: 'u1' };
    repo.findOne.mockResolvedValue(fila);
    expect(await service.fila('d1', ConfigurableProcess.SCHEDULED_TASKS)).toBe(
      fila,
    );
    repo.findOne.mockResolvedValue(null);
    expect(
      await service.fila('d1', ConfigurableProcess.SCHEDULED_TASKS),
    ).toBeNull();
  });

  it('guardar: upsert por distribuidora y proceso, con quién modificó', async () => {
    await service.guardar(
      'd1',
      ConfigurableProcess.DISPATCH,
      { offerTtlSeconds: 60 },
      'u1',
    );

    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT ("distributor_id", "module")');
    expect(sql).toContain(
      '"updated_by_user_id" = EXCLUDED."updated_by_user_id"',
    );
    expect(params).toEqual([
      'd1',
      'dispatch',
      JSON.stringify({ offerTtlSeconds: 60 }),
      'u1',
    ]);
  });
});
