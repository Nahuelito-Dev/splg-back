import {
  StockCondition,
  StockMovementReason,
} from '../../stock/domain/stock.enums';
import { CargaInvalidaError } from './errors/truck-load.errors';
import { TruckLoadStatus } from './truck-load.enums';
import {
  RenglonDeCierre,
  diferenciaDe,
  esperadoDe,
  motivoSinPedidos,
  estadoDeCierre,
  planDeCierre,
  puedeHacer,
  validarDeclaracion,
  validarQueLlevaAlgo,
  validarRenglones,
} from './truck-load-rules';

const CAMION = 'loc-camion';
const DEPOSITO = 'loc-deposito';

const renglon = (over: Partial<RenglonDeCierre> = {}): RenglonDeCierre => ({
  gasCylinderId: 'g-10',
  expectedFull: 20,
  expectedEmpty: 40,
  declaredFull: 20,
  declaredEmpty: 40,
  balanceFull: 20,
  balanceEmpty: 40,
  ...over,
});

describe('truck-load-rules', () => {
  describe('puedeHacer (máquina de estados)', () => {
    const tabla: Array<[Parameters<typeof puedeHacer>[0], TruckLoadStatus[]]> =
      [
        ['editar', [TruckLoadStatus.LOADING]],
        ['salir', [TruckLoadStatus.LOADING]],
        ['reponer', [TruckLoadStatus.ON_ROUTE]],
        ['declarar', [TruckLoadStatus.ON_ROUTE, TruckLoadStatus.RETURNED]],
        ['cerrar', [TruckLoadStatus.RETURNED]],
        ['cancelar', [TruckLoadStatus.LOADING]],
      ];
    it.each(tabla)(
      '%s sólo desde los estados permitidos',
      (accion, permitidos) => {
        for (const estado of Object.values(TruckLoadStatus)) {
          expect(puedeHacer(accion, estado)).toBe(permitidos.includes(estado));
        }
      },
    );
  });

  describe('renglones de carga', () => {
    it('rechaza dos renglones de la misma garrafa', () => {
      expect(() =>
        validarRenglones([
          { gasCylinderId: 'a', loadedFull: 1, loadedEmpty: 0 },
          { gasCylinderId: 'a', loadedFull: 2, loadedEmpty: 0 },
        ]),
      ).toThrow(/misma garrafa/);
    });

    it('rechaza cantidades negativas o con decimales', () => {
      expect(() =>
        validarRenglones([
          { gasCylinderId: 'a', loadedFull: -1, loadedEmpty: 0 },
        ]),
      ).toThrow(CargaInvalidaError);
      expect(() =>
        validarRenglones([
          { gasCylinderId: 'a', loadedFull: 1.5, loadedEmpty: 0 },
        ]),
      ).toThrow(CargaInvalidaError);
    });

    it('para salir tiene que llevar algo (llenas o vacías)', () => {
      expect(() =>
        validarQueLlevaAlgo([
          { gasCylinderId: 'a', loadedFull: 0, loadedEmpty: 0 },
        ]),
      ).toThrow(/no tiene garrafas/);
      expect(() =>
        validarQueLlevaAlgo([
          { gasCylinderId: 'a', loadedFull: 0, loadedEmpty: 3 },
        ]),
      ).not.toThrow();
    });
  });

  describe('esperadoDe (D6: canje 1 a 1)', () => {
    it('llenas = cargadas + repuestas - entregadas; vacías = cargadas + recolectadas', () => {
      expect(
        esperadoDe({
          loadedFull: 40,
          reloadedFull: 10,
          deliveredFull: 30,
          loadedEmpty: 5,
          collectedEmpty: 30,
        }),
      ).toEqual({ expectedFull: 20, expectedEmpty: 35 });
    });

    it('la diferencia es declarado menos esperado', () => {
      expect(diferenciaDe(18, 20)).toBe(-2);
      expect(diferenciaDe(21, 20)).toBe(1);
      expect(diferenciaDe(20, 20)).toBe(0);
    });
  });

  describe('validarDeclaracion', () => {
    const d = (gasCylinderId: string, declaredFull = 0, declaredEmpty = 0) => ({
      gasCylinderId,
      declaredFull,
      declaredEmpty,
    });

    it('exige declarar TODAS las garrafas de la carga', () => {
      expect(() => validarDeclaracion([d('a')], ['a', 'b'])).toThrow(
        /Falta declarar 1/,
      );
      expect(() =>
        validarDeclaracion([d('a'), d('b')], ['a', 'b']),
      ).not.toThrow();
    });

    it('rechaza repetidas y cantidades inválidas', () => {
      expect(() => validarDeclaracion([d('a'), d('a')], ['a'])).toThrow(
        /misma garrafa/,
      );
      expect(() => validarDeclaracion([d('a', -1)], ['a'])).toThrow(
        CargaInvalidaError,
      );
    });
  });

  describe('planDeCierre', () => {
    const porRazon = (
      plan: ReturnType<typeof planDeCierre>,
      reason: StockMovementReason,
    ) => plan.movimientos.filter((m) => m.reason === reason);

    it('sin diferencia: vuelve lo declarado, no hay ajustes y cierra "closed"', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [renglon()]);
      expect(plan.hayDiferencia).toBe(false);
      expect(estadoDeCierre(plan.hayDiferencia)).toBe(TruckLoadStatus.CLOSED);
      expect(plan.movimientos).toEqual([
        {
          gasCylinderId: 'g-10',
          quantity: 20,
          from: { locationId: CAMION, condition: StockCondition.FULL },
          to: { locationId: DEPOSITO, condition: StockCondition.FULL },
          reason: StockMovementReason.TRUCK_RETURN,
        },
        {
          gasCylinderId: 'g-10',
          quantity: 40,
          from: { locationId: CAMION, condition: StockCondition.EMPTY },
          to: { locationId: DEPOSITO, condition: StockCondition.EMPTY },
          reason: StockMovementReason.TRUCK_RETURN,
        },
      ]);
    });

    it('faltante de llenas: lo declarado vuelve y el resto sale como merma', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [
        renglon({ declaredFull: 17 }),
      ]);
      expect(plan.hayDiferencia).toBe(true);
      expect(estadoDeCierre(true)).toBe(TruckLoadStatus.CLOSED_WITH_DIFFERENCE);
      expect(plan.renglones[0]).toMatchObject({
        differenceFull: -3,
        differenceEmpty: 0,
      });
      const merma = porRazon(plan, StockMovementReason.SHRINKAGE);
      expect(merma).toHaveLength(1);
      expect(merma[0]).toMatchObject({
        quantity: 3,
        from: { locationId: CAMION, condition: StockCondition.FULL },
        to: null,
      });
    });

    it('sobrante de llenas: entra como ajuste y todo lo declarado vuelve', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [
        renglon({ declaredFull: 22 }),
      ]);
      expect(plan.renglones[0].differenceFull).toBe(2);
      const ajuste = porRazon(plan, StockMovementReason.ADJUSTMENT);
      expect(ajuste).toHaveLength(1);
      expect(ajuste[0]).toMatchObject({
        quantity: 2,
        from: null,
        to: { locationId: CAMION, condition: StockCondition.FULL },
      });
      const vuelta = porRazon(plan, StockMovementReason.TRUCK_RETURN).find(
        (m) => m.to?.condition === StockCondition.FULL,
      );
      expect(vuelta?.quantity).toBe(22);
    });

    it('faltante de vacías: mismo tratamiento sobre la condición vacía', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [
        renglon({ declaredEmpty: 38 }),
      ]);
      expect(plan.renglones[0]).toMatchObject({
        differenceFull: 0,
        differenceEmpty: -2,
      });
      expect(porRazon(plan, StockMovementReason.SHRINKAGE)[0]).toMatchObject({
        quantity: 2,
        from: { locationId: CAMION, condition: StockCondition.EMPTY },
      });
    });

    it('el camión siempre queda en cero: lo que vuelve + merma - sobrante = saldo', () => {
      const casos: Array<[number, number]> = [
        [20, 20],
        [17, 20],
        [24, 20],
        [0, 20],
        [5, 0],
      ];
      for (const [declared, balance] of casos) {
        const plan = planDeCierre(CAMION, DEPOSITO, [
          renglon({
            declaredFull: declared,
            balanceFull: balance,
            declaredEmpty: 0,
            balanceEmpty: 0,
          }),
        ]);
        const neto = plan.movimientos.reduce((acc, m) => {
          if (m.from?.locationId === CAMION) acc -= m.quantity;
          if (m.to?.locationId === CAMION) acc += m.quantity;
          return acc;
        }, balance);
        expect(neto).toBe(0);
      }
    });

    it('un ajuste del libro cuenta como diferencia aunque lo esperado coincida (camión con algo que la carga no lista)', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [
        renglon({
          expectedFull: 0,
          expectedEmpty: 0,
          declaredFull: 0,
          declaredEmpty: 0,
          balanceFull: 4,
          balanceEmpty: 0,
        }),
      ]);
      expect(plan.renglones[0]).toMatchObject({
        differenceFull: 0,
        differenceEmpty: 0,
      });
      expect(plan.hayDiferencia).toBe(true);
      expect(porRazon(plan, StockMovementReason.SHRINKAGE)[0].quantity).toBe(4);
    });

    it('las defectuosas vuelven al depósito sin declaración ni diferencia, y dejan el camión en cero', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [
        renglon({ balanceDefective: 3 }),
      ]);
      const defectuosas = plan.movimientos.filter(
        (m) => m.from?.condition === StockCondition.DEFECTIVE,
      );
      expect(defectuosas).toEqual([
        {
          gasCylinderId: 'g-10',
          quantity: 3,
          from: { locationId: CAMION, condition: StockCondition.DEFECTIVE },
          to: { locationId: DEPOSITO, condition: StockCondition.DEFECTIVE },
          reason: StockMovementReason.TRUCK_RETURN,
        },
      ]);
      expect(plan.hayDiferencia).toBe(false);
    });

    it('declarar cero con saldo cero no genera movimientos', () => {
      const plan = planDeCierre(CAMION, DEPOSITO, [
        renglon({
          expectedFull: 0,
          expectedEmpty: 0,
          declaredFull: 0,
          declaredEmpty: 0,
          balanceFull: 0,
          balanceEmpty: 0,
        }),
      ]);
      expect(plan.movimientos).toHaveLength(0);
      expect(plan.hayDiferencia).toBe(false);
    });
  });

  describe('motivoSinPedidos (quién recibe y acepta pedidos)', () => {
    const carga = (status: TruckLoadStatus, carId = 'car-1') => ({
      number: 4,
      status,
      carId,
    });

    it('sin carga: puede si no se exige (default), no puede si se exige', () => {
      expect(
        motivoSinPedidos({
          exige: false,
          carga: null,
          vehiculoEnUsoId: 'car-1',
        }),
      ).toBeNull();
      expect(
        motivoSinPedidos({
          exige: true,
          carga: null,
          vehiculoEnUsoId: 'car-1',
        }),
      ).toEqual({ codigo: 'sin-carga' });
    });

    it.each([true, false])(
      'con la carga en ruta y su camión puede (exige=%s)',
      (exige) => {
        expect(
          motivoSinPedidos({
            exige,
            carga: carga(TruckLoadStatus.ON_ROUTE),
            vehiculoEnUsoId: 'car-1',
          }),
        ).toBeNull();
      },
    );

    it.each([true, false])(
      'en carga todavía no sale y devuelta ya volvió: no recibe aunque D5 esté en %s',
      (exige) => {
        expect(
          motivoSinPedidos({
            exige,
            carga: carga(TruckLoadStatus.LOADING),
            vehiculoEnUsoId: 'car-1',
          }),
        ).toEqual({ codigo: 'sin-salir', number: 4 });
        expect(
          motivoSinPedidos({
            exige,
            carga: carga(TruckLoadStatus.RETURNED),
            vehiculoEnUsoId: 'car-1',
          }),
        ).toEqual({ codigo: 'devuelta', number: 4 });
      },
    );

    it('en ruta pero con otro vehículo en uso (o ninguno) no recibe', () => {
      for (const enUso of ['car-2', null]) {
        expect(
          motivoSinPedidos({
            exige: false,
            carga: carga(TruckLoadStatus.ON_ROUTE),
            vehiculoEnUsoId: enUso,
          }),
        ).toEqual({ codigo: 'otro-vehiculo', number: 4 });
      }
    });
  });
});
