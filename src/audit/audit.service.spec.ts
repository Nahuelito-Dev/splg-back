import { Repository } from 'typeorm';
import { AuditService, NuevoAsiento } from './audit.service';
import { AuditLog, AuditResult } from './entities/audit-log.entity';

describe('AuditService', () => {
  let repo: { create: jest.Mock; save: jest.Mock; findAndCount: jest.Mock };
  let service: AuditService;

  beforeEach(() => {
    repo = {
      create: jest.fn((a: NuevoAsiento) => a),
      save: jest.fn().mockResolvedValue(undefined),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    service = new AuditService(repo as unknown as Repository<AuditLog>);
  });

  it('si la base rechaza el asiento, la operación no se cae', async () => {
    repo.save.mockRejectedValue(new Error('caída'));
    await expect(
      service.registrar({ httpMethod: 'POST' } as NuevoAsiento),
    ).resolves.toBeUndefined();
  });

  it('con distribuidora en contexto sólo consulta lo de ella', async () => {
    await service.consultar(
      { limit: 50, offset: 0, result: AuditResult.FAILURE },
      'd1',
    );
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { distributorId: 'd1', result: AuditResult.FAILURE },
        order: { createdAt: 'DESC', auditId: 'ASC' },
      }),
    );
  });

  it('el super admin sin "ver como" consulta todo', async () => {
    await service.consultar({ limit: 50, offset: 0 }, null);
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});
