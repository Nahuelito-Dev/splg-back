import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SupplierKind } from '../domain/purchase.enums';
import { SupplierService } from './supplier.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const S1 = 'ssssssss-0000-4000-8000-000000000001';

function armar(
  existente: Partial<{
    supplierId: string;
    businessName: string;
    cuit: string;
  }> | null,
) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(existente),
    create: jest.fn((d: unknown) => d),
    save: jest.fn((d: unknown) => Promise.resolve(d)),
  };
  const manager = {
    query: jest.fn(),
    getRepository: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
  return {
    service: new SupplierService(repo as never, dataSource),
    repo,
    manager,
  };
}

describe('SupplierService', () => {
  it('no deja repetir el CUIT dentro de la distribuidora', async () => {
    const { service, repo } = armar({
      supplierId: S1,
      businessName: 'Otro S.A.',
    });
    await expect(
      service.create(
        { businessName: 'X', cuit: '30712345671', kind: SupplierKind.OTHER },
        DIST,
      ),
    ).rejects.toThrow(
      /Ya hay un proveedor vigente con el CUIT 30712345671: Otro S.A./,
    );
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { distributorId: DIST, cuit: '30712345671' },
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('crea con el tenant de quien pide', async () => {
    const { service, repo } = armar(null);
    await service.create(
      { businessName: 'X', cuit: '30712345671', kind: SupplierKind.OTHER },
      DIST,
    );
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ distributorId: DIST, cuit: '30712345671' }),
    );
  });

  it('un proveedor de otra distribuidora es 404', async () => {
    const { service } = armar(null);
    await expect(service.findOne(S1, DIST)).rejects.toThrow(
      /Proveedor no encontrado/,
    );
  });

  it('no se da de baja con órdenes abiertas', async () => {
    const { service, manager } = armar(null);
    manager.query
      .mockResolvedValueOnce([{ supplier_id: S1 }])
      .mockResolvedValueOnce([{ abiertas: 2 }]);
    await expect(service.remove(S1, DIST)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('bloquearUsable rechaza un proveedor inactivo y uno ajeno', async () => {
    const { service, manager } = armar(null);
    manager.query.mockResolvedValueOnce([{ is_active: false }]);
    await expect(
      service.bloquearUsable(manager as never, S1, DIST),
    ).rejects.toThrow(/inactivo/);
    manager.query.mockResolvedValueOnce([]);
    await expect(
      service.bloquearUsable(manager as never, S1, DIST),
    ).rejects.toThrow(/Proveedor no encontrado/);
  });

  it('crearEn da de alta con el repositorio de la transacción de quien llama', async () => {
    const { service, repo } = armar(null);
    const repoDeLaTransaccion = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d: unknown) => d),
      save: jest.fn((d: unknown) => Promise.resolve(d)),
    };
    const manager = { getRepository: jest.fn(() => repoDeLaTransaccion) };

    await service.crearEn(
      manager as never,
      { businessName: 'X', cuit: '30712345671', kind: SupplierKind.OTHER },
      DIST,
    );

    expect(repoDeLaTransaccion.save).toHaveBeenCalledWith(
      expect.objectContaining({ distributorId: DIST, cuit: '30712345671' }),
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('crearEn tampoco deja repetir el CUIT dentro de la distribuidora', async () => {
    const { service } = armar(null);
    const repoDeLaTransaccion = {
      findOne: jest
        .fn()
        .mockResolvedValue({ supplierId: S1, businessName: 'Otro S.A.' }),
      create: jest.fn(),
      save: jest.fn(),
    };
    const manager = { getRepository: jest.fn(() => repoDeLaTransaccion) };

    await expect(
      service.crearEn(
        manager as never,
        { businessName: 'X', cuit: '30712345671', kind: SupplierKind.OTHER },
        DIST,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repoDeLaTransaccion.save).not.toHaveBeenCalled();
  });

  it('cuitsVigentes devuelve los CUIT de la distribuidora', async () => {
    const { service, repo } = armar(null);
    (repo as unknown as { find: jest.Mock }).find = jest
      .fn()
      .mockResolvedValue([{ cuit: '30712345671' }, { cuit: '20123456786' }]);

    await expect(service.cuitsVigentes(DIST)).resolves.toEqual(
      new Set(['30712345671', '20123456786']),
    );
    expect((repo as unknown as { find: jest.Mock }).find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { distributorId: DIST } }),
    );
  });
});
