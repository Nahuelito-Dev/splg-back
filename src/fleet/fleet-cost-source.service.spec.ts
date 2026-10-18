import { Repository } from 'typeorm';
import { FleetCostSourceService } from './fleet-cost-source.service';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { MaintenanceDocumentKind } from './entities/maintenance-plan.entity';
import { VehicleUsageLog } from './entities/vehicle-usage-log.entity';

describe('FleetCostSourceService', () => {
  let service: FleetCostSourceService;
  let qbTareas: Record<string, jest.Mock>;
  let qbUso: Record<string, jest.Mock>;

  const cadena = (extra: Record<string, jest.Mock>) => {
    const qb: Record<string, jest.Mock> = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      ...extra,
    };
    return qb;
  };

  beforeEach(() => {
    qbTareas = cadena({ getMany: jest.fn().mockResolvedValue([]) });
    qbUso = cadena({ getRawMany: jest.fn().mockResolvedValue([]) });
    service = new FleetCostSourceService(
      {
        createQueryBuilder: jest.fn(() => qbTareas),
      } as unknown as Repository<MaintenanceTask>,
      {
        createQueryBuilder: jest.fn(() => qbUso),
      } as unknown as Repository<VehicleUsageLog>,
    );
  });

  it('sin vehículos no consulta nada', async () => {
    const desde = new Date();
    expect(await service.mantenimiento('d1', [], desde, desde)).toEqual([]);
    expect(await service.seguros('d1', [], desde)).toEqual([]);
    expect(await service.kmDeUso('d1', [], '2026-10-01', '2026-10-31')).toEqual(
      [],
    );
    expect(qbTareas.where).not.toHaveBeenCalled();
    expect(qbUso.where).not.toHaveBeenCalled();
  });

  it('mantenimiento: sólo tareas hechas con costo, acotadas a la distribuidora y sin las pólizas', async () => {
    const performedAt = new Date('2026-10-10T12:00:00.000Z');
    qbTareas.getMany.mockResolvedValue([
      { carId: 'c1', performedAt, cost: 1000 },
    ]);
    const desde = new Date('2026-10-01T03:00:00.000Z');
    const hasta = new Date('2026-11-01T03:00:00.000Z');

    const filas = await service.mantenimiento('d1', ['c1'], desde, hasta);

    expect(filas).toEqual([{ carId: 'c1', performedAt, cost: 1000 }]);
    expect(qbTareas.where).toHaveBeenCalledWith(
      'task.distributor_id = :distributorId',
      { distributorId: 'd1' },
    );
    expect(qbTareas.andWhere).toHaveBeenCalledWith(
      'plan.document_kind IS DISTINCT FROM :seguro',
      { seguro: MaintenanceDocumentKind.INSURANCE },
    );
    expect(qbTareas.andWhere).toHaveBeenCalledWith(
      'task.status = :hecha',
      expect.anything(),
    );
  });

  it('seguros: las pólizas no canceladas con prima cuya vigencia termina en el rango o después', async () => {
    const dueAt = new Date('2026-12-31T00:00:00.000Z');
    qbTareas.getMany.mockResolvedValue([
      { carId: 'c1', validFrom: null, dueAt, cost: 365000 },
    ]);
    const filas = await service.seguros('d1', ['c1'], new Date());
    expect(filas).toEqual([
      { carId: 'c1', validFrom: null, dueAt, cost: 365000 },
    ]);
    expect(qbTareas.andWhere).toHaveBeenCalledWith(
      'plan.document_kind = :seguro',
      { seguro: MaintenanceDocumentKind.INSURANCE },
    );
    expect(qbTareas.andWhere).toHaveBeenCalledWith(
      'task.status <> :cancelada',
      expect.anything(),
    );
  });

  it('kmDeUso: suma por vehículo y devuelve números', async () => {
    qbUso.getRawMany.mockResolvedValue([{ carId: 'c1', km: '1234.50' }]);
    expect(
      await service.kmDeUso('d1', ['c1'], '2026-10-01', '2026-10-31'),
    ).toEqual([{ carId: 'c1', km: 1234.5 }]);
    expect(qbUso.where).toHaveBeenCalledWith(
      'u.distributor_id = :distributorId',
      { distributorId: 'd1' },
    );
  });
});
