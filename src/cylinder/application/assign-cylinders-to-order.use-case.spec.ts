import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { EnvasesVencidosException } from '../cylinder-vencido.exception';
import { CylinderState } from '../domain/cylinder-state';
import { InvalidCylinderTransitionError } from '../domain/errors/invalid-cylinder-transition.error';
import { AssignCylindersToOrderUseCase } from './assign-cylinders-to-order.use-case';
import {
  ChoferesEnMemoria,
  DIST,
  EnvasesEnMemoria,
  EventosRegistrados,
  MovimientosEnMemoria,
  PedidosEnMemoria,
  RelojFijo,
  UnidadDeTrabajoEnMemoria,
  datosDeEnvase,
  enDias,
} from './dobles-de-puertos';

describe('AssignCylindersToOrderUseCase (con dobles de los puertos)', () => {
  let envases: EnvasesEnMemoria;
  let movimientos: MovimientosEnMemoria;
  let pedidos: PedidosEnMemoria;
  let eventos: EventosRegistrados;
  let asignar: AssignCylindersToOrderUseCase;

  const lleno = (serial: string, expiresAt: Date | null = enDias(100)) =>
    datosDeEnvase({
      cylinderId: `cyl-${serial}`,
      serial,
      state: CylinderState.FILLED,
      expiresAt,
    });

  const armar = (...iniciales: ReturnType<typeof datosDeEnvase>[]) => {
    envases = new EnvasesEnMemoria(...iniciales);
    movimientos = new MovimientosEnMemoria();
    pedidos = new PedidosEnMemoria(envases.bloqueos);
    eventos = new EventosRegistrados();
    asignar = new AssignCylindersToOrderUseCase(
      envases,
      movimientos,
      pedidos,
      new ChoferesEnMemoria({ 'user-chofer': 'del-1' }),
      eventos,
      new UnidadDeTrabajoEnMemoria(envases, movimientos),
      new RelojFijo(),
    );
    pedidos.poner({ orderId: 'ord-1', deliveryId: 'del-1' });
  };

  it('despacha los envases, los ata al pedido y asienta un movimiento por cada uno', async () => {
    armar(lleno('SN-1'), lleno('SN-2'));

    const asignados = await asignar.execute(
      'ord-1',
      ['SN-2', 'SN-1'],
      DIST,
      'admin-1',
    );

    // En el orden en que se pidieron.
    expect(asignados.map((e) => e.serial)).toEqual(['SN-2', 'SN-1']);
    expect(envases.todos()).toEqual([
      expect.objectContaining({
        state: CylinderState.DISPATCHED,
        currentOrderId: 'ord-1',
      }),
      expect.objectContaining({
        state: CylinderState.DISPATCHED,
        currentOrderId: 'ord-1',
      }),
    ]);
    expect(movimientos.asentados).toHaveLength(2);
    expect(movimientos.asentados[0]).toMatchObject({
      fromState: CylinderState.FILLED,
      toState: CylinderState.DISPATCHED,
      orderId: 'ord-1',
      actorUserId: 'admin-1',
      note: 'Asignado al pedido ord-1',
    });
  });

  it('bloquea el pedido antes que los envases, y los envases en orden de serial', async () => {
    armar(lleno('SN-1'), lleno('SN-2'));

    await asignar.execute('ord-1', ['SN-2', 'SN-1'], DIST);

    expect(envases.bloqueos).toEqual([
      'pedido:ord-1',
      'envase:cyl-SN-1',
      'envase:cyl-SN-2',
    ]);
  });

  it('CU-135: un vencido rechaza la carga completa, informa los seriales, no escribe nada y avisa', async () => {
    armar(lleno('SN-1'), lleno('SN-2', enDias(-1)));

    const error: unknown = await asignar
      .execute('ord-1', ['SN-1', 'SN-2'], DIST)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnvasesVencidosException);
    expect((error as EnvasesVencidosException).serials).toEqual(['SN-2']);
    expect(envases.ver('cyl-SN-1').state).toBe(CylinderState.FILLED);
    expect(movimientos.asentados).toHaveLength(0);
    expect(eventos.bloqueados).toEqual([
      { distributorId: DIST, orderId: 'ord-1', serials: ['SN-2'] },
    ]);
  });

  it('un envase sin revisión registrada pasa y queda anotado', async () => {
    armar(lleno('SN-1', null));

    await asignar.execute('ord-1', ['SN-1'], DIST);

    expect(movimientos.asentados[0].note).toBe(
      'Asignado al pedido ord-1 (sin revisión registrada)',
    );
    expect(eventos.bloqueados).toHaveLength(0);
  });

  it('un envase que no está lleno es 400 (transición inválida) y no avisa bloqueo', async () => {
    armar(lleno('SN-1'), {
      ...lleno('SN-2', enDias(-1)),
      state: CylinderState.IN_DEPOT,
    });

    await expect(
      asignar.execute('ord-1', ['SN-1', 'SN-2'], DIST),
    ).rejects.toBeInstanceOf(InvalidCylinderTransitionError);
    expect(envases.ver('cyl-SN-1').state).toBe(CylinderState.FILLED);
    expect(eventos.bloqueados).toHaveLength(0);
  });

  it('seriales repetidos: 400 sin abrir transacción', async () => {
    armar(lleno('SN-1'));
    await expect(
      asignar.execute('ord-1', ['SN-1', 'SN-1'], DIST),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(envases.bloqueos).toEqual([]);
  });

  it('un serial que no existe o es de otra distribuidora: 404 sin escribir', async () => {
    armar(lleno('SN-1'), { ...lleno('SN-AJENO'), distributorId: 'dist-2' });

    await expect(
      asignar.execute('ord-1', ['SN-1', 'SN-AJENO'], DIST),
    ).rejects.toThrow('Envase no encontrado');
    expect(envases.ver('cyl-SN-1').state).toBe(CylinderState.FILLED);
  });

  it('el pedido de otra distribuidora no existe (H-90)', async () => {
    armar(lleno('SN-1'));
    pedidos.poner({ orderId: 'ord-ajeno' }, 'dist-2');

    await expect(
      asignar.execute('ord-ajeno', ['SN-1'], DIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['reserved', 'delivered', 'cancelled'] as const)(
    'a un pedido %s no se le cargan envases: 409',
    async (status) => {
      armar(lleno('SN-1'));
      pedidos.poner({ orderId: 'ord-1', status });

      await expect(asignar.execute('ord-1', ['SN-1'], DIST)).rejects.toThrow(
        'no se le pueden asignar envases',
      );
      expect(envases.ver('cyl-SN-1').state).toBe(CylinderState.FILLED);
    },
  );

  describe('chofer', () => {
    it('carga a su pedido', async () => {
      armar(lleno('SN-1'));
      await asignar.execute(
        'ord-1',
        ['SN-1'],
        DIST,
        'user-chofer',
        RoleType.DELIVERY,
      );
      expect(envases.ver('cyl-SN-1').state).toBe(CylinderState.DISPATCHED);
    });

    it('el pedido de otro chofer no existe para él, aunque esté entregado: 404', async () => {
      armar(lleno('SN-1'));
      pedidos.poner({
        orderId: 'ord-1',
        deliveryId: 'del-otro',
        status: 'delivered',
      });

      await expect(
        asignar.execute(
          'ord-1',
          ['SN-1'],
          DIST,
          'user-chofer',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow('Pedido no encontrado');
    });

    it('un usuario sin perfil de chofer no carga: 404', async () => {
      armar(lleno('SN-1'));
      await expect(
        asignar.execute(
          'ord-1',
          ['SN-1'],
          DIST,
          'user-sin-perfil',
          RoleType.DELIVERY,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
