import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Warehouse } from '../entities/warehouse.entity';
import { StockLocation } from '../entities/stock-location.entity';
import { StockThreshold } from '../entities/stock-threshold.entity';
import { WarehouseService } from './warehouse.service';
import { UbicacionDeDepositoInvalidaError } from '../domain/errors/stock.errors';

const DIST = 'dddddddd-0000-4000-8000-000000000001';

const deposito = (over: Partial<Warehouse> = {}): Warehouse =>
  ({
    warehouseId: 'w1',
    distributorId: DIST,
    name: 'Central',
    code: 'CENTRAL',
    isDefault: false,
    isActive: true,
    ...over,
  }) as Warehouse;

function armar(
  opts: {
    warehouse?: Warehouse | null;
    total?: string;
    defaults?: Warehouse[];
    /** Número de una carga abierta que sale de este depósito. */
    cargaAbierta?: number;
  } = {},
) {
  const warehouseRepo = {
    findOne: jest.fn().mockResolvedValue(opts.warehouse ?? null),
    find: jest.fn().mockResolvedValue(opts.defaults ?? []),
    exists: jest.fn().mockResolvedValue((opts.defaults ?? []).length > 0),
    save: jest.fn((w: Warehouse) =>
      Promise.resolve({ ...w, warehouseId: w.warehouseId ?? 'nuevo' }),
    ),
    softRemove: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((d: Partial<Warehouse>) => d),
    createQueryBuilder: jest.fn(() => ({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(opts.warehouse ?? null),
    })),
  };
  const locationRepo = {
    save: jest.fn((l: unknown) =>
      Promise.resolve({ ...(l as object), locationId: 'loc-nueva' }),
    ),
    create: jest.fn((d: unknown) => d),
    findOneOrFail: jest.fn().mockResolvedValue({ locationId: 'loc-1' }),
  };
  const query = jest
    .fn<Promise<unknown[]>, [string, unknown[]?]>()
    .mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('"truck_load"')
          ? opts.cargaAbierta === undefined
            ? []
            : [{ number: opts.cargaAbierta }]
          : [{ total: opts.total ?? '0' }],
      ),
    );
  const borrar = jest.fn().mockResolvedValue(undefined);
  const getRepository = jest.fn((e: unknown) =>
    e === Warehouse ? warehouseRepo : e === StockLocation ? locationRepo : {},
  );
  const transaction = jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
    cb(manager),
  );
  const manager = {
    getRepository,
    query,
    delete: borrar,
    transaction,
  } as unknown as EntityManager;
  const dataSource = {
    transaction,
    manager,
    getRepository,
  } as unknown as DataSource;
  const service = new WarehouseService(
    dataSource,
    warehouseRepo as unknown as Repository<Warehouse>,
  );
  return { service, borrar, warehouseRepo, locationRepo, query, transaction };
}

describe('WarehouseService', () => {
  describe('baja lógica', () => {
    it('da de baja (softRemove) un depósito sin saldo y borra sus umbrales', async () => {
      const w = deposito();
      const { service, warehouseRepo, borrar } = armar({
        warehouse: w,
        total: '0',
      });
      await service.remove('w1', DIST);
      expect(warehouseRepo.softRemove).toHaveBeenCalledWith(w);
      expect(borrar).toHaveBeenCalledWith(StockThreshold, {
        warehouseId: 'w1',
      });
    });

    it('con garrafas en cualquier condición es 409 y no se da de baja', async () => {
      const { service, warehouseRepo } = armar({
        warehouse: deposito(),
        total: '12',
      });
      await expect(service.remove('w1', DIST)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(warehouseRepo.softRemove).not.toHaveBeenCalled();
    });

    it('el origen de una carga abierta no se da de baja: 409 con el número de la carga', async () => {
      const { service, warehouseRepo, borrar } = armar({
        warehouse: deposito(),
        cargaAbierta: 8,
      });
      await expect(service.remove('w1', DIST)).rejects.toThrow(
        /origen de la carga N° 8.*darlo de baja/,
      );
      expect(warehouseRepo.softRemove).not.toHaveBeenCalled();
      expect(borrar).not.toHaveBeenCalled();
    });

    it('el predeterminado no se da de baja', async () => {
      const { service, warehouseRepo } = armar({
        warehouse: deposito({ isDefault: true }),
      });
      await expect(service.remove('w1', DIST)).rejects.toThrow(
        /predeterminado/,
      );
      expect(warehouseRepo.softRemove).not.toHaveBeenCalled();
    });

    it('uno de otra distribuidora (o inexistente) es 404', async () => {
      const { service } = armar({ warehouse: null });
      await expect(service.remove('w1', DIST)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('toma el lock exclusivo del depósito antes de mirar el saldo', async () => {
      const { service, warehouseRepo } = armar({ warehouse: deposito() });
      await service.remove('w1', DIST);
      const qb = warehouseRepo.createQueryBuilder.mock.results[0].value as {
        setLock: jest.Mock;
      };
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
    });
  });

  describe('predeterminado', () => {
    it('el primer depósito que se crea queda como predeterminado', async () => {
      const { service, warehouseRepo } = armar({ defaults: [] });
      await service.create({ name: 'Central', code: 'CENTRAL' }, DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        isDefault: true,
      });
    });

    it('uno nuevo no es predeterminado si ya hay uno', async () => {
      const { service, warehouseRepo } = armar({
        defaults: [deposito({ isDefault: true })],
      });
      await service.create({ name: 'Sucursal', code: 'SUC' }, DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        isDefault: false,
      });
    });

    it('marcar otro como predeterminado le saca la marca al anterior', async () => {
      const anterior = deposito({ warehouseId: 'w0', isDefault: true });
      const nuevo = deposito({ warehouseId: 'w1', isDefault: false });
      const { service, warehouseRepo } = armar({
        warehouse: nuevo,
        defaults: [anterior],
      });
      await service.update('w1', { isDefault: true }, DIST);
      const guardados = warehouseRepo.save.mock.calls.map((c) => c[0]);
      expect(guardados[0]).toMatchObject({
        warehouseId: 'w0',
        isDefault: false,
      });
      expect(guardados[1]).toMatchObject({
        warehouseId: 'w1',
        isDefault: true,
      });
    });

    it('el choque del único predeterminado vigente da un mensaje de concurrencia, no de código repetido', async () => {
      const { service, warehouseRepo } = armar({ defaults: [] });
      warehouseRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), {
          code: '23505',
          constraint: 'UQ_warehouse_default_vigente',
        }),
      );
      await expect(
        service.create({ name: 'X', code: 'X' }, DIST),
      ).rejects.toThrow(/al mismo tiempo/);
    });

    it('un código repetido sigue diciendo código repetido', async () => {
      const { service, warehouseRepo } = armar({ defaults: [] });
      warehouseRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), {
          code: '23505',
          constraint: 'UQ_warehouse_code_vigente',
        }),
      );
      await expect(
        service.create({ name: 'X', code: 'X' }, DIST),
      ).rejects.toThrow(/ese código/);
    });

    it('al cambiar el predeterminado bloquea los dos depósitos juntos y en orden por id', async () => {
      const { service, query } = armar({
        warehouse: deposito({ isDefault: false }),
        defaults: [deposito({ warehouseId: 'w0', isDefault: true })],
      });
      await service.update('w1', { isDefault: true }, DIST);
      const sql = query.mock.calls[0][0];
      expect(sql).toMatch(/ORDER BY "warehouse_id"\s+FOR UPDATE/);
      expect(query.mock.calls[0][1]).toEqual([DIST, 'w1']);
    });

    it('un depósito inactivo no puede ser el predeterminado (ni al marcarlo ni junto con desactivarlo)', async () => {
      const inactivo = armar({
        warehouse: deposito({ isDefault: false, isActive: false }),
        defaults: [deposito({ warehouseId: 'w0', isDefault: true })],
      });
      await expect(
        inactivo.service.update('w1', { isDefault: true }, DIST),
      ).rejects.toThrow(/predeterminado no puede estar inactivo/);
      const junto = armar({
        warehouse: deposito({ isDefault: false }),
        defaults: [deposito({ warehouseId: 'w0', isDefault: true })],
      });
      await expect(
        junto.service.update('w1', { isDefault: true, isActive: false }, DIST),
      ).rejects.toBeInstanceOf(BadRequestException);
      // activándolo en el mismo pedido sí se puede
      const activando = armar({
        warehouse: deposito({ isDefault: false, isActive: false }),
        defaults: [deposito({ warehouseId: 'w0', isDefault: true })],
      });
      await expect(
        activando.service.update(
          'w1',
          { isDefault: true, isActive: true },
          DIST,
        ),
      ).resolves.toBeDefined();
    });

    it('desactivar el origen de una carga abierta es 409 y toma el lock exclusivo del depósito', async () => {
      const { service, warehouseRepo } = armar({
        warehouse: deposito(),
        cargaAbierta: 9,
      });
      await expect(
        service.update('w1', { isActive: false }, DIST),
      ).rejects.toThrow(/origen de la carga N° 9.*desactivarlo/);
      expect(warehouseRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(warehouseRepo.save).not.toHaveBeenCalled();
    });

    it('desactivar un depósito sin cargas abiertas sigue andando', async () => {
      const { service, warehouseRepo } = armar({ warehouse: deposito() });
      await service.update('w1', { isActive: false }, DIST);
      expect(warehouseRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
    });

    it('no se le saca la marca ni se desactiva al predeterminado', async () => {
      const { service } = armar({ warehouse: deposito({ isDefault: true }) });
      await expect(
        service.update('w1', { isDefault: false }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.update('w1', { isActive: false }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('asegurarPredeterminado', () => {
    it('si ya hay uno lo devuelve y no crea nada', async () => {
      const w = deposito({ isDefault: true });
      const { service, warehouseRepo } = armar({ warehouse: w });
      const r = await service.asegurarPredeterminado(DIST);
      expect(r.warehouse).toBe(w);
      expect(warehouseRepo.save).not.toHaveBeenCalled();
    });

    it('si no hay ninguno crea el "Depósito central" con su ubicación', async () => {
      const { service, warehouseRepo, locationRepo } = armar({
        warehouse: null,
      });
      const r = await service.asegurarPredeterminado(DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        name: 'Depósito central',
        code: 'CENTRAL',
        isDefault: true,
        distributorId: DIST,
      });
      expect(locationRepo.save).toHaveBeenCalled();
      expect(r.locationId).toBe('loc-nueva');
    });
  });

  describe('ubicación (v2)', () => {
    const POSADAS = { type: 'Point', coordinates: [-55.8961, -27.3671] };

    it('el alta con latitud y longitud guarda el punto (GeoJSON va lng, lat)', async () => {
      const { service, warehouseRepo } = armar({ defaults: [] });
      await service.create(
        {
          name: 'Galpón',
          code: 'GAL',
          latitude: -27.3671,
          longitude: -55.8961,
        },
        DIST,
      );
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        location: POSADAS,
      });
    });

    it('el alta sin coordenadas queda sin ubicación', async () => {
      const { service, warehouseRepo } = armar({ defaults: [] });
      await service.create({ name: 'Galpón', code: 'GAL' }, DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        location: null,
      });
    });

    it('una sola coordenada es 400 y no abre la transacción', async () => {
      const { service, warehouseRepo, transaction } = armar({ defaults: [] });
      await expect(
        service.create({ name: 'G', code: 'G', latitude: -27.3 }, DIST),
      ).rejects.toThrow(UbicacionDeDepositoInvalidaError);
      expect(transaction).not.toHaveBeenCalled();
      expect(warehouseRepo.save).not.toHaveBeenCalled();
    });

    it('el alta con las dos en null es 400: borrar es de la edición', async () => {
      const { service, warehouseRepo } = armar({ defaults: [] });
      await expect(
        service.create(
          { name: 'G', code: 'G', latitude: null, longitude: null },
          DIST,
        ),
      ).rejects.toThrow(UbicacionDeDepositoInvalidaError);
      expect(warehouseRepo.save).not.toHaveBeenCalled();
    });

    it('una coordenada fuera de rango en la edición es 400 y no guarda', async () => {
      const { service, warehouseRepo } = armar({ warehouse: deposito() });
      await expect(
        service.update('w1', { latitude: 91, longitude: 0 }, DIST),
      ).rejects.toThrow(UbicacionDeDepositoInvalidaError);
      expect(warehouseRepo.save).not.toHaveBeenCalled();
    });

    it('la edición fija la ubicación', async () => {
      const { service, warehouseRepo } = armar({ warehouse: deposito() });
      await service.update(
        'w1',
        { latitude: -27.3671, longitude: -55.8961 },
        DIST,
      );
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        location: POSADAS,
      });
    });

    it('la edición con las dos en null borra la ubicación', async () => {
      const { service, warehouseRepo } = armar({
        warehouse: deposito({ location: POSADAS as Warehouse['location'] }),
      });
      await service.update('w1', { latitude: null, longitude: null }, DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        location: null,
      });
    });

    it('la edición sin coordenadas no toca la ubicación', async () => {
      const { service, warehouseRepo } = armar({
        warehouse: deposito({ location: POSADAS as Warehouse['location'] }),
      });
      await service.update('w1', { name: 'Otro nombre' }, DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        name: 'Otro nombre',
        location: POSADAS,
      });
    });

    it('el predeterminado que se crea solo nace sin ubicación', async () => {
      const { service, warehouseRepo } = armar({ warehouse: null });
      await service.asegurarPredeterminado(DIST);
      expect(warehouseRepo.save.mock.calls[0][0]).toMatchObject({
        location: null,
      });
    });
  });
});
