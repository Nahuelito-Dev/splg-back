import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { EnvasesVencidosException } from '../cylinder-vencido.exception';
import { CylinderState } from '../domain/cylinder-state';
import { InvalidCylinderTransitionError } from '../domain/errors/invalid-cylinder-transition.error';
import {
  ChoferesEnMemoria,
  CuentaDeEnvasesEnMemoria,
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
import { TransitionCylinderUseCase } from './transition-cylinder.use-case';

describe('TransitionCylinderUseCase (con dobles de los puertos)', () => {
  let envases: EnvasesEnMemoria;
  let movimientos: MovimientosEnMemoria;
  let pedidos: PedidosEnMemoria;
  let cuenta: CuentaDeEnvasesEnMemoria;
  let eventos: EventosRegistrados;
  let transicionar: TransitionCylinderUseCase;

  const armar = (over: Parameters<typeof datosDeEnvase>[0] = {}) => {
    envases = new EnvasesEnMemoria(datosDeEnvase(over));
    movimientos = new MovimientosEnMemoria();
    pedidos = new PedidosEnMemoria(envases.bloqueos);
    cuenta = new CuentaDeEnvasesEnMemoria();
    eventos = new EventosRegistrados();
    transicionar = new TransitionCylinderUseCase(
      envases,
      movimientos,
      pedidos,
      new ChoferesEnMemoria({ 'user-chofer': 'del-1' }),
      cuenta,
      eventos,
      new UnidadDeTrabajoEnMemoria(envases, movimientos),
      new RelojFijo(),
    );
    pedidos.poner({ orderId: 'ord-a', deliveryId: 'del-1', customerId: 'c-a' });
    pedidos.poner({ orderId: 'ord-b', deliveryId: 'del-2', customerId: 'c-b' });
  };

  const comoChofer = ['user-chofer', RoleType.DELIVERY] as const;

  it('mueve el envase y asienta el movimiento', async () => {
    armar();

    await transicionar.execute(
      'cyl-1',
      { toState: CylinderState.FILLED, note: 'cargado en planta' },
      DIST,
      'admin-1',
    );

    expect(envases.ver('cyl-1').state).toBe(CylinderState.FILLED);
    expect(movimientos.asentados).toEqual([
      expect.objectContaining({
        fromState: CylinderState.IN_DEPOT,
        toState: CylinderState.FILLED,
        actorUserId: 'admin-1',
        note: 'cargado en planta',
      }),
    ]);
  });

  it('una transición inválida no persiste nada', async () => {
    armar();

    await expect(
      transicionar.execute(
        'cyl-1',
        { toState: CylinderState.DISPATCHED },
        DIST,
      ),
    ).rejects.toBeInstanceOf(InvalidCylinderTransitionError);
    expect(envases.ver('cyl-1').state).toBe(CylinderState.IN_DEPOT);
    expect(movimientos.asentados).toHaveLength(0);
  });

  it('la baja no va por acá, y entregar exige el pedido: 400', async () => {
    armar();
    await expect(
      transicionar.execute('cyl-1', { toState: CylinderState.RETIRED }, DIST),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      transicionar.execute(
        'cyl-1',
        { toState: CylinderState.WITH_CUSTOMER },
        DIST,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el envase de otra distribuidora no existe: 404', async () => {
    armar();
    await expect(
      transicionar.execute(
        'cyl-1',
        { toState: CylinderState.FILLED },
        'dist-2',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('al entregarlo queda a nombre del titular del pedido', async () => {
    armar({ state: CylinderState.DISPATCHED, currentOrderId: 'ord-a' });

    await transicionar.execute(
      'cyl-1',
      { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-a' },
      DIST,
    );

    expect(envases.ver('cyl-1')).toMatchObject({
      state: CylinderState.WITH_CUSTOMER,
      currentCustomerId: 'c-a',
      currentOrderId: 'ord-a',
    });
  });

  it('bloquea los pedidos (en orden de id) antes que el envase', async () => {
    armar({ state: CylinderState.DISPATCHED, currentOrderId: 'ord-b' });

    await transicionar
      .execute(
        'cyl-1',
        { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-a' },
        DIST,
      )
      .catch(() => undefined);

    expect(envases.bloqueos).toEqual([
      'pedido:ord-a',
      'pedido:ord-b',
      'envase:cyl-1',
    ]);
  });

  it('despachar a un pedido que no admite carga: 409', async () => {
    armar({ state: CylinderState.FILLED });
    pedidos.poner({ orderId: 'ord-a', status: 'cancelled' });

    await expect(
      transicionar.execute(
        'cyl-1',
        { toState: CylinderState.DISPATCHED, orderId: 'ord-a' },
        DIST,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('CU-135: un vencido no se despacha por esta puerta: 409, sin cambios, y avisa', async () => {
    armar({ state: CylinderState.FILLED, expiresAt: enDias(-1) });

    const error: unknown = await transicionar
      .execute(
        'cyl-1',
        { toState: CylinderState.DISPATCHED, orderId: 'ord-a' },
        DIST,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnvasesVencidosException);
    expect(envases.ver('cyl-1').state).toBe(CylinderState.FILLED);
    expect(movimientos.asentados).toHaveLength(0);
    expect(eventos.bloqueados).toEqual([
      { distributorId: DIST, orderId: 'ord-a', serials: ['SN-001'] },
    ]);
  });

  describe('devolución de un envase que tenía un cliente', () => {
    const conCliente = {
      state: CylinderState.WITH_CUSTOMER,
      currentCustomerId: 'c-a',
      currentOrderId: 'ord-a',
    };

    it('baja la cuenta de envases en la misma transacción y avisa la devolución', async () => {
      armar(conCliente);

      await transicionar.execute(
        'cyl-1',
        { toState: CylinderState.EMPTY_RETURNED },
        DIST,
      );

      expect(envases.ver('cyl-1')).toMatchObject({
        state: CylinderState.EMPTY_RETURNED,
        currentCustomerId: null,
      });
      expect(cuenta.descuentos).toEqual([
        {
          tx: { numero: 1 },
          customerUserId: 'c-a',
          cylinderId: 'cyl-1',
          orderId: null,
        },
      ]);
      expect(eventos.devueltos).toEqual([
        {
          distributorId: DIST,
          cylinderId: 'cyl-1',
          customerId: 'c-a',
          orderId: null,
        },
      ]);
    });

    it('si la cuenta falla, la devolución se deshace y no se avisa', async () => {
      armar(conCliente);
      cuenta.falla = new Error('cuenta caída');

      await expect(
        transicionar.execute(
          'cyl-1',
          { toState: CylinderState.EMPTY_RETURNED },
          DIST,
        ),
      ).rejects.toThrow('cuenta caída');

      expect(envases.ver('cyl-1')).toMatchObject(conCliente);
      expect(movimientos.asentados).toHaveLength(0);
      expect(eventos.devueltos).toHaveLength(0);
    });
  });

  describe('chofer', () => {
    it('devuelve al depósito un envase de su pedido', async () => {
      armar({ state: CylinderState.DISPATCHED, currentOrderId: 'ord-a' });

      await transicionar.execute(
        'cyl-1',
        { toState: CylinderState.IN_DEPOT },
        DIST,
        ...comoChofer,
      );

      expect(envases.ver('cyl-1')).toMatchObject({
        state: CylinderState.IN_DEPOT,
        currentOrderId: null,
      });
    });

    it('un envase atado al pedido de otro chofer no existe para él: 404', async () => {
      armar({ state: CylinderState.DISPATCHED, currentOrderId: 'ord-b' });

      await expect(
        transicionar.execute(
          'cyl-1',
          { toState: CylinderState.IN_DEPOT },
          DIST,
          ...comoChofer,
        ),
      ).rejects.toThrow('Envase no encontrado');
      expect(envases.ver('cyl-1').state).toBe(CylinderState.DISPATCHED);
    });

    it('con el envase atado a su pedido no puede indicar otro: 409', async () => {
      armar({ state: CylinderState.DISPATCHED, currentOrderId: 'ord-a' });
      pedidos.poner({ orderId: 'ord-c', deliveryId: 'del-1' });

      await expect(
        transicionar.execute(
          'cyl-1',
          { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-c' },
          DIST,
          ...comoChofer,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un envase sin pedido y sin indicar pedido es tarea de depósito: 403', async () => {
      armar();
      await expect(
        transicionar.execute(
          'cyl-1',
          { toState: CylinderState.FILLED },
          DIST,
          ...comoChofer,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no despacha a un pedido de otro chofer: 404', async () => {
      armar({ state: CylinderState.FILLED });
      await expect(
        transicionar.execute(
          'cyl-1',
          { toState: CylinderState.DISPATCHED, orderId: 'ord-b' },
          DIST,
          ...comoChofer,
        ),
      ).rejects.toThrow('Pedido no encontrado');
    });
  });
});
