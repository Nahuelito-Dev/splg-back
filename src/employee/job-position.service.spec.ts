import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { JobPositionService } from './job-position.service';
import {
  JobPosition,
  JobPositionCategory,
} from './entities/job-position.entity';
import { Employee } from './entities/employee.entity';
import { UsersService } from '../users/users.service';
import { BASE_POSITION_DEFINITIONS } from './domain/base-positions';

describe('JobPositionService', () => {
  let positions: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    softRemove: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { query: jest.Mock; getRepository: () => unknown };
  };
  let employees: {
    count: jest.Mock;
    find?: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let users: { findRoleTypes: jest.Mock };
  let nombreOcupado: boolean;
  let service: JobPositionService;

  const puesto = (over: Partial<JobPosition> = {}): JobPosition =>
    ({
      positionId: 'p1',
      distributorId: 'd1',
      name: 'Chofer',
      category: JobPositionCategory.DRIVER,
      isActive: true,
      ...over,
    }) as JobPosition;

  beforeEach(() => {
    nombreOcupado = false;
    const consulta = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn(() => Promise.resolve(nombreOcupado)),
    };
    positions = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn((p: Partial<JobPosition>) => p),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
      softRemove: jest.fn(),
      createQueryBuilder: jest.fn(() => consulta),
      manager: {
        query: jest.fn(),
        getRepository: () => positions,
      },
    };
    employees = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    users = { findRoleTypes: jest.fn() };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: (entidad: unknown) =>
        entidad === Employee ? employees : positions,
    };
    const dataSource = {
      transaction: (fn: (m: unknown) => Promise<unknown>) => fn(manager),
    };
    service = new JobPositionService(
      positions as unknown as Repository<JobPosition>,
      employees as unknown as Repository<Employee>,
      users as unknown as UsersService,
      dataSource as unknown as DataSource,
    );
  });

  it('crear con un nombre ya usado (sin distinguir mayúsculas) es 409', async () => {
    nombreOcupado = true;
    await expect(
      service.create(
        { name: 'chofer', category: JobPositionCategory.DRIVER },
        'd1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(positions.save).not.toHaveBeenCalled();
  });

  it('crear deja el puesto activo en la distribuidora del que pide', async () => {
    const { puesto: creado } = await service.create(
      { name: 'Repartidor', category: JobPositionCategory.DRIVER },
      'd1',
    );
    expect(creado).toMatchObject({
      distributorId: 'd1',
      name: 'Repartidor',
      isActive: true,
    });
  });

  it('un puesto de otra distribuidora es 404', async () => {
    positions.findOne.mockResolvedValue(null);
    await expect(
      service.update('p1', { name: 'x' }, 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(positions.findOne).toHaveBeenCalledWith({
      where: { positionId: 'p1', distributorId: 'd1' },
    });
  });

  it('eliminar con empleados activos es 409 y dice cuántos', async () => {
    positions.findOne.mockResolvedValue(puesto());
    employees.count.mockResolvedValue(3);

    await expect(service.remove('p1', 'd1')).rejects.toThrow(/3 empleado/);
    expect(positions.softRemove).not.toHaveBeenCalled();
  });

  it('eliminar un puesto que figura en legajos egresados es 409 y sugiere desactivarlo', async () => {
    positions.findOne.mockResolvedValue(puesto());
    employees.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    await expect(service.remove('p1', 'd1')).rejects.toThrow(/isActive=false/);
    expect(positions.softRemove).not.toHaveBeenCalled();
  });

  it('no deja desactivar, recategorizar ni eliminar el último puesto activo de chofer', async () => {
    positions.findOne.mockResolvedValue(puesto());
    positions.count.mockResolvedValue(0);

    await expect(
      service.update('p1', { isActive: false }, 'd1'),
    ).rejects.toThrow(/último puesto activo/);
    await expect(
      service.update('p1', { category: JobPositionCategory.OTHER }, 'd1'),
    ).rejects.toThrow(/último puesto activo/);
    await expect(service.remove('p1', 'd1')).rejects.toThrow(
      /último puesto activo/,
    );
    expect(positions.save).not.toHaveBeenCalled();
    expect(positions.softRemove).not.toHaveBeenCalled();
  });

  it('recategorizar un puesto con una cuenta de rol incompatible es 409', async () => {
    positions.findOne.mockResolvedValue(puesto());
    positions.count.mockResolvedValue(1);
    employees.find = jest.fn().mockResolvedValue([{ userId: 'u1' }]);
    users.findRoleTypes.mockResolvedValue(new Map([['u1', 'delivery']]));

    await expect(
      service.update(
        'p1',
        { category: JobPositionCategory.ADMINISTRATION },
        'd1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(positions.save).not.toHaveBeenCalled();

    // Una categoría con el mismo rol sí se puede.
    await service.update('p1', { category: JobPositionCategory.DRIVER }, 'd1');
  });

  it('un nombre repetido por carrera (violación del único) sale como 409, no 500', async () => {
    positions.save.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    await expect(
      service.create(
        { name: 'Nuevo', category: JobPositionCategory.OTHER },
        'd1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('eliminar sin empleados activos es una baja lógica', async () => {
    positions.findOne.mockResolvedValue(puesto());
    positions.count.mockResolvedValue(1);
    await service.remove('p1', 'd1');
    expect(positions.softRemove).toHaveBeenCalled();
  });

  it('asignar un puesto inactivo es 409', async () => {
    const manager = {
      getRepository: () => ({
        findOne: jest.fn().mockResolvedValue(puesto({ isActive: false })),
      }),
    } as unknown as EntityManager;
    await expect(
      service.findAsignable(manager, 'p1', 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sembrar es idempotente: si ya tiene puestos no crea ninguno', async () => {
    positions.count.mockResolvedValue(2);
    await expect(service.sembrarBase('d1')).resolves.toBe(0);
    expect(positions.manager.query).not.toHaveBeenCalled();
  });

  it('sembrar crea los 5 puestos base con ON CONFLICT DO NOTHING (altas simultáneas no chocan)', async () => {
    positions.count.mockResolvedValue(0);
    positions.manager.query.mockResolvedValue([{ position_id: 'x' }]);

    await expect(service.sembrarBase('d1')).resolves.toBe(
      BASE_POSITION_DEFINITIONS.length,
    );

    const llamadas = positions.manager.query.mock.calls as [string, string[]][];
    expect(llamadas.map(([, p]) => p[1])).toEqual([
      'Chofer',
      'Ayudante',
      'Depósito',
      'Administración',
      'Vendedor',
    ]);
    expect(
      llamadas.every(([sql]) => sql.includes('ON CONFLICT DO NOTHING')),
    ).toBe(true);
  });
});
