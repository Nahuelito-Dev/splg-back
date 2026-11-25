import { ConflictException, NotFoundException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { CylinderInspectionResult } from '../domain/cylinder-inspection-result';
import { CylinderState } from '../domain/cylinder-state';
import { InvalidCylinderTransitionError } from '../domain/errors/invalid-cylinder-transition.error';
import { CreateCylinderUseCase } from './create-cylinder.use-case';
import { DeliverOrderCylindersUseCase } from './deliver-order-cylinders.use-case';
import {
  CatalogoEnMemoria,
  DIST,
  EnvasesEnMemoria,
  MovimientosEnMemoria,
  PedidosEnMemoria,
  RelojFijo,
  RevisionesEnMemoria,
  UnidadDeTrabajoEnMemoria,
  datosDeEnvase,
  enDias,
} from './dobles-de-puertos';
import { RegisterInspectionUseCase } from './register-inspection.use-case';
import { RetireCylinderUseCase } from './retire-cylinder.use-case';
import { UpdateCylinderUseCase } from './update-cylinder.use-case';

describe('casos de uso de envases (con dobles de los puertos)', () => {
  let envases: EnvasesEnMemoria;
  let movimientos: MovimientosEnMemoria;
  let revisiones: RevisionesEnMemoria;
  let uow: UnidadDeTrabajoEnMemoria;
  const reloj = new RelojFijo();
  const catalogo = new CatalogoEnMemoria(['prod-1']);

  const armar = (...iniciales: ReturnType<typeof datosDeEnvase>[]) => {
    envases = new EnvasesEnMemoria(...iniciales);
    movimientos = new MovimientosEnMemoria();
    revisiones = new RevisionesEnMemoria();
    uow = new UnidadDeTrabajoEnMemoria(envases, movimientos, revisiones);
  };

  describe('CreateCylinderUseCase', () => {
    const crear = () =>
      new CreateCylinderUseCase(envases, movimientos, catalogo);

    it('da de alta en el depósito, con el serial canónico y su primer movimiento', async () => {
      armar();

      const envase = await crear().execute(
        { serial: ' sn-7 ', gasCylinderId: 'prod-1', deposit: 500 },
        DIST,
      );

      expect(envase.snapshot()).toMatchObject({
        distributorId: DIST,
        serial: 'SN-7',
        gasCylinderId: 'prod-1',
        deposit: 500,
        state: CylinderState.IN_DEPOT,
      });
      expect(movimientos.asentados).toEqual([
        expect.objectContaining({
          cylinderId: envase.cylinderId,
          fromState: null,
          toState: CylinderState.IN_DEPOT,
        }),
      ]);
    });

    it('el mismo serial (en cualquier forma) en la distribuidora es 409; en otra, pasa', async () => {
      armar(datosDeEnvase({ serial: 'SN-7' }));

      await expect(
        crear().execute({ serial: 'sn-7 ' }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        crear().execute({ serial: 'SN-7' }, 'dist-2'),
      ).resolves.toBeDefined();
    });

    it('un serial en blanco es 400 y un producto que no es de la distribuidora, 404; no se guarda nada', async () => {
      armar();

      await expect(
        crear().execute({ serial: '   ' }, DIST),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        crear().execute({ serial: 'SN-1', gasCylinderId: 'prod-ajeno' }, DIST),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(envases.todos()).toHaveLength(0);
      expect(movimientos.asentados).toHaveLength(0);
    });
  });

  describe('UpdateCylinderUseCase', () => {
    const editar = () =>
      new UpdateCylinderUseCase(envases, catalogo, uow, reloj);

    it('edita los datos maestros sin tocar el estado ni asentar movimientos', async () => {
      armar(datosDeEnvase({ state: CylinderState.FILLED }));

      await editar().execute('cyl-1', { serial: 'sn-x', deposit: 9 }, DIST);

      expect(envases.ver('cyl-1')).toMatchObject({
        serial: 'SN-X',
        deposit: 9,
        state: CylinderState.FILLED,
      });
      expect(movimientos.asentados).toHaveLength(0);
    });

    it('404 si no es de la distribuidora, 409 si está dado de baja o el serial ya existe', async () => {
      armar(
        datosDeEnvase(),
        datosDeEnvase({ cylinderId: 'cyl-2', serial: 'SN-002' }),
        datosDeEnvase({
          cylinderId: 'cyl-3',
          serial: 'SN-003',
          state: CylinderState.RETIRED,
        }),
      );

      await expect(
        editar().execute('cyl-1', { deposit: 1 }, 'dist-2'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        editar().execute('cyl-3', { deposit: 1 }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        editar().execute('cyl-1', { serial: 'sn-002' }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(envases.ver('cyl-1').serial).toBe('SN-001');
    });
  });

  describe('RetireCylinderUseCase', () => {
    const baja = () =>
      new RetireCylinderUseCase(envases, movimientos, uow, reloj);

    it('da de baja con el motivo en el historial', async () => {
      armar(datosDeEnvase());

      await baja().execute('cyl-1', 'golpeado', DIST, 'admin-1');

      expect(envases.ver('cyl-1').state).toBe(CylinderState.RETIRED);
      expect(movimientos.asentados[0]).toMatchObject({
        toState: CylinderState.RETIRED,
        note: 'Baja: golpeado',
        actorUserId: 'admin-1',
      });
    });

    it('uno en poder de un cliente no se da de baja por la vía común', async () => {
      armar(
        datosDeEnvase({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'c-1',
        }),
      );

      await expect(baja().execute('cyl-1', 'x', DIST)).rejects.toBeInstanceOf(
        InvalidCylinderTransitionError,
      );
      expect(envases.ver('cyl-1').state).toBe(CylinderState.WITH_CUSTOMER);
    });

    it('la baja por pérdida corre en la transacción de quien decide y libera al cliente', async () => {
      armar(
        datosDeEnvase({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'c-1',
        }),
      );

      await baja().porPerdida('cyl-1', 'extraviado', DIST, 'admin-1', {});

      expect(uow.abiertas).toBe(0);
      expect(envases.ver('cyl-1')).toMatchObject({
        state: CylinderState.RETIRED,
        currentCustomerId: null,
      });
      expect(movimientos.asentados[0].note).toBe(
        'Baja por pérdida: extraviado',
      );
    });

    it('si ya no está con un cliente, la baja por pérdida es 409', async () => {
      armar(datosDeEnvase({ state: CylinderState.EMPTY_RETURNED }));
      await expect(
        baja().porPerdida('cyl-1', 'x', DIST, 'admin-1', {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('DeliverOrderCylindersUseCase (lo que usa el puerto de pedidos)', () => {
    let pedidos: PedidosEnMemoria;
    const entregar = () =>
      new DeliverOrderCylindersUseCase(
        envases,
        movimientos,
        pedidos,
        uow,
        reloj,
      );
    const despachado = (id: string, orderId = 'ord-1') =>
      datosDeEnvase({
        cylinderId: id,
        serial: id,
        state: CylinderState.DISPATCHED,
        currentOrderId: orderId,
      });

    beforeEach(() => {
      pedidos = new PedidosEnMemoria();
      pedidos.poner({ orderId: 'ord-1', customerId: 'cust-7' });
    });

    it('pasa al titular los envases despachados de ese pedido, y sólo esos', async () => {
      armar(
        despachado('a'),
        despachado('b'),
        despachado('c', 'ord-otro'),
        datosDeEnvase({
          cylinderId: 'd',
          serial: 'd',
          state: CylinderState.EMPTY_RETURNED,
          currentOrderId: 'ord-1',
        }),
      );

      expect(await entregar().execute('ord-1', DIST)).toBe(2);

      expect(envases.ver('a')).toMatchObject({
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: 'cust-7',
      });
      expect(envases.ver('c').state).toBe(CylinderState.DISPATCHED);
      expect(envases.ver('d').state).toBe(CylinderState.EMPTY_RETURNED);
      expect(movimientos.asentados).toHaveLength(2);
      expect(movimientos.asentados[0]).toMatchObject({
        orderId: 'ord-1',
        note: 'Entregado (auto al confirmar la entrega del pedido)',
      });
    });

    it('es idempotente: la segunda vez no hay nada que avanzar', async () => {
      armar(despachado('a'));
      await entregar().execute('ord-1', DIST);

      expect(await entregar().execute('ord-1', DIST)).toBe(0);
      expect(movimientos.asentados).toHaveLength(1);
    });

    it('con la transacción de quien llama no abre otra; sin ella, abre la propia', async () => {
      armar(despachado('a'), despachado('b', 'ord-2'));
      pedidos.poner({ orderId: 'ord-2' });

      await entregar().execute('ord-1', DIST, { deQuienLlama: true });
      expect(uow.abiertas).toBe(0);

      await entregar().execute('ord-2', DIST);
      expect(uow.abiertas).toBe(1);
    });

    it('un pedido sin envases no hace nada', async () => {
      armar();
      expect(await entregar().execute('ord-1', DIST)).toBe(0);
    });
  });

  describe('RegisterInspectionUseCase', () => {
    const registrar = () =>
      new RegisterInspectionUseCase(
        envases,
        revisiones,
        movimientos,
        uow,
        reloj,
      );
    // AHORA es el 15/10/2026 al mediodía de Buenos Aires.
    const aprobada = {
      inspectedAt: '2026-10-14',
      result: CylinderInspectionResult.APPROVED,
      nextDueAt: '2031-10-14',
    };

    it('asienta la revisión y actualiza la ficha del envase', async () => {
      armar(datosDeEnvase());

      await registrar().execute('cyl-1', aprobada, DIST);

      expect(revisiones.asentadas).toHaveLength(1);
      expect(envases.ver('cyl-1').expiresAt).toEqual(
        revisiones.asentadas[0].nextDueAt,
      );
    });

    it('un rechazo con el envase en poder de un cliente lo deja vencido y marcado en el historial', async () => {
      armar(
        datosDeEnvase({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'c-1',
          expiresAt: enDias(200),
        }),
      );

      await registrar().execute(
        'cyl-1',
        {
          inspectedAt: '2026-10-14',
          result: CylinderInspectionResult.REJECTED,
        },
        DIST,
        'admin-1',
      );

      expect(envases.ver('cyl-1').state).toBe(CylinderState.WITH_CUSTOMER);
      expect(envases.ver('cyl-1').expiresAt!.getTime()).toBeLessThan(
        reloj.ahora().getTime(),
      );
      expect(movimientos.asentados).toEqual([
        expect.objectContaining({
          note: 'Revisión rechazada: retirar el envase cuando vuelva',
          actorUserId: 'admin-1',
        }),
      ]);
    });

    it('una fecha futura es 400 sin abrir transacción; un envase ajeno, 404; uno dado de baja, 409', async () => {
      armar(
        datosDeEnvase(),
        datosDeEnvase({
          cylinderId: 'cyl-2',
          serial: 'SN-002',
          state: CylinderState.RETIRED,
        }),
      );

      await expect(
        registrar().execute(
          'cyl-1',
          { ...aprobada, inspectedAt: '2026-10-16' },
          DIST,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(uow.abiertas).toBe(0);
      await expect(
        registrar().execute('cyl-1', aprobada, 'dist-2'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        registrar().execute('cyl-2', aprobada, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(revisiones.asentadas).toHaveLength(0);
    });

    it('una revisión anterior a la última sólo entra al historial', async () => {
      armar(
        datosDeEnvase({
          lastInspectionAt: enDias(-1),
          expiresAt: enDias(900),
        }),
      );

      await registrar().execute(
        'cyl-1',
        { ...aprobada, inspectedAt: '2026-09-01' },
        DIST,
      );

      expect(revisiones.asentadas).toHaveLength(1);
      expect(envases.ver('cyl-1').expiresAt).toEqual(enDias(900));
    });
  });
});
