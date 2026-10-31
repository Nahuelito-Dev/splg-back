import { Reflector } from '@nestjs/core';
import { RoleType } from '../common/constants/role-type.enum';
import { DriverRouteBatchesController } from './driver-route-batches.controller';
import { RouteBatchQueryService } from './route-batch-query.service';
import { RouteBatchController } from './route-batch.controller';
import { RouteBatchService } from './route-batch.service';
import { RouteBatchStatus } from '../order/entities/route-batch.entity';

describe('controladores de los recorridos', () => {
  let service: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let admin: RouteBatchController;
  let driver: DriverRouteBatchesController;

  beforeEach(() => {
    service = {
      parametrosVigentes: jest.fn().mockResolvedValue({ params: {} }),
      cambiarParametros: jest.fn().mockResolvedValue({ params: {} }),
      armarAhora: jest
        .fn()
        .mockResolvedValue({ candidates: 4, batches: 1, orders: 2 }),
      deshacerPorAdmin: jest.fn().mockResolvedValue(undefined),
      aceptar: jest.fn().mockResolvedValue({
        batchId: 'b1',
        accepted: true,
        assignedOrders: 2,
      }),
      rechazar: jest.fn().mockResolvedValue({
        batchId: 'b1',
        accepted: false,
        assignedOrders: 0,
      }),
    };
    query = {
      listar: jest.fn().mockResolvedValue({ data: [], total: 0, counts: {} }),
      detalle: jest.fn().mockResolvedValue({ batchId: 'b1' }),
      delChofer: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      unoDelChofer: jest.fn().mockResolvedValue({ batchId: 'b1' }),
    };
    admin = new RouteBatchController(
      service as unknown as RouteBatchService,
      query as unknown as RouteBatchQueryService,
    );
    driver = new DriverRouteBatchesController(
      service as unknown as RouteBatchService,
      query as unknown as RouteBatchQueryService,
    );
  });

  it('el listado se acota a la distribuidora y pagina con valores por omisión', async () => {
    await admin.lotes({ status: RouteBatchStatus.OFFERED }, 'd1');

    expect(query.listar).toHaveBeenCalledWith('d1', {
      status: RouteBatchStatus.OFFERED,
      limit: 10,
      offset: 0,
    });
  });

  it('el detalle se pide con la distribuidora del contexto', async () => {
    await admin.uno('b1', 'd1');
    expect(query.detalle).toHaveBeenCalledWith('d1', 'b1');
  });

  it('los parámetros se leen y se cambian por distribuidora', async () => {
    await admin.settings('d1');
    await admin.settingsPatch({ groupingRadiusKm: 5 }, 'd1', 'admin-1');

    expect(service.parametrosVigentes).toHaveBeenCalledWith('d1');
    expect(service.cambiarParametros).toHaveBeenCalledWith(
      'd1',
      { groupingRadiusKm: 5 },
      'admin-1',
    );
  });

  it('armar ahora corre la pasada de la distribuidora', async () => {
    expect(await admin.run('d1')).toEqual({
      candidates: 4,
      batches: 1,
      orders: 2,
    });
    expect(service.armarAhora).toHaveBeenCalledWith('d1');
  });

  it('deshacer devuelve el lote como quedó', async () => {
    await admin.deshacer('b1', 'd1');

    expect(service.deshacerPorAdmin).toHaveBeenCalledWith('d1', 'b1');
    expect(query.detalle).toHaveBeenCalledWith('d1', 'b1');
  });

  it('el chofer lista, ve, acepta y rechaza sus lotes con SU usuario', async () => {
    await driver.list({}, 'u1');
    await driver.one('b1', 'u1');
    await driver.accept('b1', 'u1');
    await driver.reject('b1', 'u1');

    expect(query.delChofer).toHaveBeenCalledWith('u1', 10, 0);
    expect(query.unoDelChofer).toHaveBeenCalledWith('u1', 'b1');
    expect(service.aceptar).toHaveBeenCalledWith('u1', 'b1');
    expect(service.rechazar).toHaveBeenCalledWith('u1', 'b1');
  });

  it('el panel es de admin y super admin; la app, del chofer', () => {
    const reflector = new Reflector();
    const roles = (clase: object): unknown =>
      reflector.get('roles', clase as never);
    expect(roles(RouteBatchController)).toEqual([
      RoleType.ADMIN,
      RoleType.SUPER_ADMIN,
    ]);
    expect(roles(DriverRouteBatchesController)).toEqual([RoleType.DELIVERY]);
  });
});
