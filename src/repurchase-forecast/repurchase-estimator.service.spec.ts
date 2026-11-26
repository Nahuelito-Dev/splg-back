import { CustomersService } from '../customer/customer.service';
import type { FichaDeRecompra } from '../customer/customer.service';
import { ProcessConfigService } from '../distributor/process-config.service';
import { PaymentMethod } from '../order/entities/order.entity';
import {
  CompraEntregadaRef,
  OrderLookupService,
} from '../order/lookup/order-lookup.service';
import { RepurchaseOffsetService } from './repurchase-offset.service';
import { RepurchaseEstimateSource } from './domain/estimacion-de-recompra';
import {
  ParametrosDeRecompra,
  RepurchaseEstimatorService,
} from './repurchase-estimator.service';

const DIA = 86_400_000;
const AHORA = new Date('2026-10-31T12:00:00Z');
const PARAMS: ParametrosDeRecompra = {
  enabled: true,
  minOrders: 3,
  anticipationDays: 3,
  invitationTtlHours: 24,
  minIntervalDays: 7,
  runHour: 9,
  recentOrderDays: 2,
  staleDays: 30,
};

const compra = (
  customerId: string,
  haceDias: number,
  parcial: Partial<CompraEntregadaRef> = {},
): CompraEntregadaRef => ({
  orderId: `${customerId}-${haceDias}`,
  customerId,
  deliveredAt: new Date(AHORA.getTime() - haceDias * DIA),
  addressId: 'a1',
  timeSlotId: null,
  paymentMethod: PaymentMethod.CASH,
  items: [{ gasCylinderId: 'g10', quantity: 1, weightKg: 10 }],
  ...parcial,
});

const ficha = (
  userId: string,
  parcial: Partial<FichaDeRecompra> = {},
): FichaDeRecompra => ({
  customerId: `c-${userId}`,
  userId,
  fullName: `Cliente ${userId}`,
  email: `${userId}@x.com`,
  phoneNumber: null,
  avgMonthlyConsumptionKg: null,
  declaredCylinderTypeId: null,
  noticeDays: null,
  noticeEnabled: true,
  ...parcial,
});

describe('RepurchaseEstimatorService', () => {
  let processConfig: { obtener: jest.Mock };
  let pedidos: { comprasEntregadas: jest.Mock };
  let customers: { fichasDeRecompra: jest.Mock };
  let offsets: { deClientes: jest.Mock };
  let service: RepurchaseEstimatorService;

  beforeEach(() => {
    offsets = { deClientes: jest.fn().mockResolvedValue(new Map()) };
    processConfig = { obtener: jest.fn() };
    pedidos = { comprasEntregadas: jest.fn().mockResolvedValue([]) };
    customers = { fichasDeRecompra: jest.fn().mockResolvedValue([]) };
    service = new RepurchaseEstimatorService(
      processConfig as unknown as ProcessConfigService,
      pedidos as unknown as OrderLookupService,
      customers as unknown as CustomersService,
      offsets as unknown as RepurchaseOffsetService,
    );
  });

  it('lee los parámetros del proceso `repurchase` de la distribuidora', async () => {
    processConfig.obtener.mockResolvedValue({ ...PARAMS, enabled: 1 });
    expect(await service.parametros('d1')).toEqual(PARAMS);
    expect(processConfig.obtener).toHaveBeenCalledWith('d1', 'repurchase');
  });

  it('viene apagada: enabled en 0 es false', async () => {
    processConfig.obtener.mockResolvedValue({ ...PARAMS, enabled: 0 });
    expect((await service.parametros('d1')).enabled).toBe(false);
  });

  describe('estimar', () => {
    it('estima a cada cliente con las compras que la distribuidora le entregó', async () => {
      // u1 compra 10 kg cada 4 días; la última fue hace 3 días: se le acaba mañana.
      pedidos.comprasEntregadas.mockResolvedValue([
        compra('u1', 11),
        compra('u1', 7),
        compra('u1', 3),
      ]);
      customers.fichasDeRecompra.mockResolvedValue([ficha('u1')]);

      const [e] = await service.estimar('d1', AHORA, PARAMS);

      expect(e.userId).toBe('u1');
      expect(e.customerId).toBe('c-u1');
      expect(e.estimate.source).toBe(RepurchaseEstimateSource.HISTORY);
      expect(e.estimate.estimatedAt.getTime()).toBeGreaterThan(AHORA.getTime());
      expect(e.estimate.estimatedAt.getTime()).toBeLessThan(
        AHORA.getTime() + 2 * DIA,
      );
      expect(e.habits.addressId).toBe('a1');
      expect(e.noticeDays).toBe(3);
      expect(e.ownNoticeDays).toBeNull();
      expect(pedidos.comprasEntregadas).toHaveBeenCalledWith(
        'd1',
        new Date(AHORA.getTime() - 400 * DIA),
        undefined,
      );
      expect(customers.fichasDeRecompra).toHaveBeenCalledWith('d1', ['u1']);
    });

    it('los días de aviso propios mandan sobre los de la distribuidora', async () => {
      pedidos.comprasEntregadas.mockResolvedValue([compra('u1', 2)]);
      customers.fichasDeRecompra.mockResolvedValue([
        ficha('u1', {
          avgMonthlyConsumptionKg: 30,
          noticeDays: 10,
          noticeEnabled: false,
        }),
      ]);
      const [e] = await service.estimar('d1', AHORA, PARAMS);
      expect(e.noticeDays).toBe(10);
      expect(e.ownNoticeDays).toBe(10);
      expect(e.noticeEnabled).toBe(false);
      expect(e.estimate.source).toBe(RepurchaseEstimateSource.DECLARED);
      expect(e.declaredKgPerMonth).toBe(30);
    });

    it('deja afuera al que no se puede estimar y ordena por fecha', async () => {
      pedidos.comprasEntregadas.mockResolvedValue([
        compra('tarde', 1),
        compra('sin-datos', 1),
        compra('pronto', 5),
        compra('mismo-dia-b', 3),
        compra('mismo-dia-a', 3),
      ]);
      customers.fichasDeRecompra.mockResolvedValue([
        ficha('tarde', { avgMonthlyConsumptionKg: 10 }),
        ficha('sin-datos'),
        ficha('pronto', { avgMonthlyConsumptionKg: 100 }),
        ficha('mismo-dia-b', { avgMonthlyConsumptionKg: 100 }),
        ficha('mismo-dia-a', { avgMonthlyConsumptionKg: 100 }),
      ]);
      const r = await service.estimar('d1', AHORA, PARAMS);
      expect(r.map((e) => e.userId)).toEqual([
        'pronto',
        'mismo-dia-a',
        'mismo-dia-b',
        'tarde',
      ]);
    });
  });

  describe('ajuste por cliente (M3a)', () => {
    const declarado = (userId: string) =>
      ficha(userId, { avgMonthlyConsumptionKg: 30 });

    it('con consumo declarado, corre la fecha los días de su ajuste', async () => {
      pedidos.comprasEntregadas.mockResolvedValue([compra('u1', 2)]);
      customers.fichasDeRecompra.mockResolvedValue([declarado('u1')]);
      const [sin] = await service.estimar('d1', AHORA, PARAMS);
      offsets.deClientes.mockResolvedValue(new Map([['u1', 4]]));
      const [con] = await service.estimar('d1', AHORA, PARAMS);
      expect(sin.offsetDays).toBe(0);
      expect(con.offsetDays).toBe(4);
      expect(
        con.estimate.estimatedAt.getTime() - sin.estimate.estimatedAt.getTime(),
      ).toBe(4 * DIA);
      expect(offsets.deClientes).toHaveBeenCalledWith('d1', ['u1']);
    });

    it('con historia suficiente la estimación no cambia', async () => {
      pedidos.comprasEntregadas.mockResolvedValue([
        compra('u1', 19),
        compra('u1', 15),
        compra('u1', 11),
        compra('u1', 7),
        compra('u1', 3),
      ]);
      customers.fichasDeRecompra.mockResolvedValue([ficha('u1')]);
      const [sin] = await service.estimar('d1', AHORA, PARAMS);
      offsets.deClientes.mockResolvedValue(new Map([['u1', 9]]));
      const [con] = await service.estimar('d1', AHORA, PARAMS);
      expect(con.offsetDays).toBe(0);
      expect(con.estimate.estimatedAt).toEqual(sin.estimate.estimatedAt);
    });
  });

  describe('estimarCliente', () => {
    it('devuelve su estimación', async () => {
      pedidos.comprasEntregadas.mockResolvedValue([compra('u1', 2)]);
      customers.fichasDeRecompra.mockResolvedValue([
        ficha('u1', { avgMonthlyConsumptionKg: 30 }),
      ]);
      const r = await service.estimarCliente('d1', 'u1', AHORA, PARAMS);
      expect(r?.cliente?.userId).toBe('u1');
      expect(r?.reason).toBeNull();
      expect(pedidos.comprasEntregadas).toHaveBeenCalledWith(
        'd1',
        expect.any(Date),
        'u1',
      );
      expect(customers.fichasDeRecompra).toHaveBeenCalledWith('d1', ['u1']);
    });

    it('explica por qué no se lo puede proyectar', async () => {
      customers.fichasDeRecompra.mockResolvedValue([ficha('u1')]);
      const r = await service.estimarCliente('d1', 'u1', AHORA, PARAMS);
      expect(r).toEqual({
        userId: 'u1',
        cliente: null,
        reason: 'no_purchases',
      });
    });

    it('null si no es cliente de la distribuidora', async () => {
      expect(
        await service.estimarCliente('d1', 'ajeno', AHORA, PARAMS),
      ).toBeNull();
    });
  });
});
