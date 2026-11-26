import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { PaymentMethod } from '../order/entities/order.entity';
import { RepurchaseEstimateSource } from './domain/estimacion-de-recompra';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import {
  ParametrosDeRecompra,
  RecompraEstimada,
  RepurchaseEstimatorService,
} from './repurchase-estimator.service';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseNotifier } from './repurchase-notifier';
import { RepurchaseSuggestionService } from './repurchase-suggestion.service';

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

/** Una invitación anterior del cliente. */
const ultima = (parcial: Partial<RepurchaseInvitation>): RepurchaseInvitation =>
  ({
    invitationId: 'prev',
    userId: 'u1',
    createdAt: new Date(AHORA.getTime() - 3 * DIA),
    respondedAt: new Date(AHORA.getTime() - 2 * DIA),
    status: Estado.EXPIRED,
    ...parcial,
  }) as RepurchaseInvitation;

const cliente = (
  userId: string,
  diasHastaAgotarse: number,
  parcial: Partial<RecompraEstimada> = {},
): RecompraEstimada => ({
  customerId: `c-${userId}`,
  userId,
  fullName: `Cliente ${userId}`,
  email: null,
  phoneNumber: null,
  estimate: {
    ok: true,
    estimatedAt: new Date(AHORA.getTime() + diasHastaAgotarse * DIA),
    source: RepurchaseEstimateSource.HISTORY,
    kgPerDay: 1,
    ordersUsed: 3,
    lastDeliveredAt: new Date(AHORA.getTime() - 5 * DIA),
    lastKg: 10,
  },
  offsetDays: 0,
  habits: {
    items: [{ gasCylinderId: 'g10', quantity: 1 }],
    addressId: 'a1',
    timeSlotId: null,
    paymentMethod: PaymentMethod.CASH,
  },
  declaredKgPerMonth: null,
  noticeDays: 3,
  noticeEnabled: true,
  ownNoticeDays: null,
  ...parcial,
});

describe('RepurchaseForecastService', () => {
  let estimator: { parametros: jest.Mock; estimar: jest.Mock };
  let invitaciones: {
    abrir: jest.Mock;
    abiertas: jest.Mock;
    cancelar: jest.Mock;
    vencerVencidas: jest.Mock;
    ultimasPorCliente: jest.Mock;
    reclamarAviso: jest.Mock;
    paraAvisar: jest.Mock;
  };
  let sugerencias: { armar: jest.Mock };
  let pedidos: {
    clientesConPedidoVigente: jest.Mock;
    hayPedidoDesde: jest.Mock;
  };
  let notifier: { invitar: jest.Mock; cerrada: jest.Mock };
  let service: RepurchaseForecastService;

  const sugerida = {
    ok: true,
    sugerencia: {
      items: [{ gasCylinderId: 'g10', quantity: 1 }],
      addressId: 'a1',
      timeSlotId: null,
      timeSlotStart: null,
      paymentMethod: PaymentMethod.CASH,
    },
  };

  beforeEach(() => {
    estimator = {
      parametros: jest.fn().mockResolvedValue(PARAMS),
      estimar: jest.fn().mockResolvedValue([]),
    };
    invitaciones = {
      abrir: jest
        .fn()
        .mockImplementation((d: object) =>
          Promise.resolve({ invitationId: 'inv', ...d }),
        ),
      abiertas: jest.fn().mockResolvedValue([]),
      cancelar: jest.fn().mockResolvedValue(true),
      vencerVencidas: jest.fn().mockResolvedValue([]),
      ultimasPorCliente: jest.fn().mockResolvedValue(new Map()),
      reclamarAviso: jest.fn().mockResolvedValue(true),
      paraAvisar: jest.fn().mockResolvedValue([]),
    };
    sugerencias = { armar: jest.fn().mockResolvedValue(sugerida) };
    pedidos = {
      clientesConPedidoVigente: jest.fn().mockResolvedValue(new Set()),
      hayPedidoDesde: jest.fn().mockResolvedValue(false),
    };
    notifier = {
      invitar: jest.fn().mockResolvedValue(undefined),
      cerrada: jest.fn().mockResolvedValue(undefined),
    };
    service = new RepurchaseForecastService(
      estimator as unknown as RepurchaseEstimatorService,
      invitaciones as unknown as RepurchaseInvitationService,
      sugerencias as unknown as RepurchaseSuggestionService,
      pedidos as unknown as OrderLookupService,
      notifier as unknown as RepurchaseNotifier,
    );
  });

  describe('ejecutar', () => {
    it('invita a quien se le acaba el gas dentro de su anticipación y avisa', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 2)]);

      const r = await service.ejecutar('d1', AHORA);

      expect(r.evaluated).toBe(1);
      expect(r.invited).toBe(1);
      expect(invitaciones.abrir).toHaveBeenCalledWith({
        distributorId: 'd1',
        userId: 'u1',
        addressId: 'a1',
        estimateKgPerDay: 1,
        estimateOrdersUsed: 3,
        timeSlotId: null,
        paymentMethod: PaymentMethod.CASH,
        projectedDepletionAt: new Date(AHORA.getTime() + 2 * DIA),
        estimateSource: RepurchaseEstimateSource.HISTORY,
        suggestedItems: [{ gasCylinderId: 'g10', quantity: 1 }],
        expiresAt: new Date(AHORA.getTime() + 24 * 3_600_000),
        offsetDays: 0,
        notifyAt: AHORA,
      });
      expect(notifier.invitar).toHaveBeenCalledTimes(1);
    });

    it('consulta los pedidos recientes y las últimas invitaciones con los parámetros de la distribuidora', async () => {
      await service.ejecutar('d1', AHORA);
      expect(pedidos.clientesConPedidoVigente).toHaveBeenCalledWith(
        'd1',
        new Date(AHORA.getTime() - 2 * DIA),
      );
      expect(invitaciones.ultimasPorCliente).toHaveBeenCalledWith('d1', AHORA);
    });

    it('no invita al que desactivó el aviso, al que todavía no le toca, al de pedido reciente ni al que está en enfriamiento', async () => {
      estimator.estimar.mockResolvedValue([
        cliente('apagado', 1, { noticeEnabled: false }),
        cliente('lejos', 10),
        cliente('pedido', 1),
        cliente('enfriando', 1),
        cliente('abierta', 1),
      ]);
      pedidos.clientesConPedidoVigente.mockResolvedValue(new Set(['pedido']));
      invitaciones.ultimasPorCliente.mockResolvedValue(
        new Map([
          [
            'enfriando',
            ultima({
              status: Estado.REJECTED,
              respondedAt: new Date(AHORA.getTime() - 2 * DIA),
            }),
          ],
          ['abierta', ultima({ status: Estado.PENDING, respondedAt: null })],
        ]),
      );

      const r = await service.ejecutar('d1', AHORA);

      expect(r.invited).toBe(0);
      expect(r.skipped).toEqual({
        notice_disabled: 1,
        not_yet: 1,
        recent_order: 1,
        cooldown: 2,
        same_cycle: 0,
        no_stock: 0,
        no_address: 0,
      });
      expect(invitaciones.abrir).not.toHaveBeenCalled();
    });

    describe('una invitación por ciclo de consumo', () => {
      // Última compra hace 5 días; se le acaba mañana: el ciclo estimado dura 6 días.
      const atrasado = () => cliente('u1', 1);

      it('después de una vencida o descartada del mismo ciclo no se lo vuelve a invitar', async () => {
        const c = atrasado();
        c.estimate.lastDeliveredAt = new Date(AHORA.getTime() - 30 * DIA);
        estimator.estimar.mockResolvedValue([c]);
        invitaciones.ultimasPorCliente.mockResolvedValue(
          new Map([
            [
              'u1',
              ultima({
                status: Estado.EXPIRED,
                createdAt: new Date(AHORA.getTime() - 10 * DIA),
                respondedAt: new Date(AHORA.getTime() - 9 * DIA),
              }),
            ],
          ]),
        );
        // Ya pasó el intervalo mínimo (7 días), pero la invitación es posterior a su última compra.
        const r = await service.ejecutar('d1', AHORA);
        expect(r.skipped.same_cycle).toBe(1);
        expect(r.invited).toBe(0);
      });

      it('con una compra nueva desde la invitación, se lo invita de nuevo', async () => {
        const c = atrasado();
        c.estimate.lastDeliveredAt = new Date(AHORA.getTime() - 2 * DIA);
        estimator.estimar.mockResolvedValue([c]);
        invitaciones.ultimasPorCliente.mockResolvedValue(
          new Map([
            [
              'u1',
              ultima({
                status: Estado.EXPIRED,
                createdAt: new Date(AHORA.getTime() - 10 * DIA),
                respondedAt: new Date(AHORA.getTime() - 9 * DIA),
              }),
            ],
          ]),
        );
        expect((await service.ejecutar('d1', AHORA)).invited).toBe(1);
      });

      it('pasado un ciclo estimado completo desde la invitación, se lo invita de nuevo', async () => {
        // Compró hace 40 días y se le acababa a los 10: el ciclo dura 10 días.
        const c = atrasado();
        c.estimate.lastDeliveredAt = new Date(AHORA.getTime() - 40 * DIA);
        c.estimate.estimatedAt = new Date(AHORA.getTime() - 30 * DIA);
        estimator.estimar.mockResolvedValue([c]);
        invitaciones.ultimasPorCliente.mockResolvedValue(
          new Map([
            [
              'u1',
              ultima({
                status: Estado.REJECTED,
                createdAt: new Date(AHORA.getTime() - 20 * DIA),
                respondedAt: new Date(AHORA.getTime() - 19 * DIA),
              }),
            ],
          ]),
        );
        expect((await service.ejecutar('d1', AHORA)).invited).toBe(1);
      });
    });

    it('respeta los días de aviso propios del cliente', async () => {
      estimator.estimar.mockResolvedValue([
        cliente('quiere-10', 8, { noticeDays: 10, ownNoticeDays: 10 }),
      ]);
      expect((await service.ejecutar('d1', AHORA)).invited).toBe(1);
    });

    it('invita también al que ya se pasó de la fecha', async () => {
      estimator.estimar.mockResolvedValue([cliente('atrasado', -4)]);
      expect((await service.ejecutar('d1', AHORA)).invited).toBe(1);
    });

    it.each(['no_stock', 'no_address'] as const)(
      'sin sugerencia (%s) no invita y lo cuenta',
      async (motivo) => {
        estimator.estimar.mockResolvedValue([cliente('u1', 1)]);
        sugerencias.armar.mockResolvedValue({ ok: false, reason: motivo });
        const r = await service.ejecutar('d1', AHORA);
        expect(r.skipped[motivo]).toBe(1);
        expect(r.invited).toBe(0);
      },
    );

    it('apagada (enabled en 0) no corre y responde 409; sólo la simulación funciona', async () => {
      estimator.parametros.mockResolvedValue({ ...PARAMS, enabled: false });
      await expect(service.ejecutar('d1', AHORA)).rejects.toThrow(
        'está apagada',
      );
      expect(invitaciones.vencerVencidas).not.toHaveBeenCalled();
      expect(invitaciones.abrir).not.toHaveBeenCalled();
      await expect(
        service.ejecutar('d1', AHORA, { dryRun: true }),
      ).resolves.toMatchObject({ invited: 0 });
    });

    it('si otra corrida se adelantó (invitación duplicada) cuenta enfriamiento y no avisa', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 1)]);
      invitaciones.abrir.mockResolvedValue(null);
      const r = await service.ejecutar('d1', AHORA);
      expect(r.invited).toBe(0);
      expect(r.skipped.cooldown).toBe(1);
      expect(notifier.invitar).not.toHaveBeenCalled();
    });

    it('antes de estimar vence las invitaciones sin respuesta y lo informa', async () => {
      invitaciones.vencerVencidas.mockResolvedValue([
        { invitationId: 'v1' } as RepurchaseInvitation,
      ]);
      const r = await service.ejecutar('d1', AHORA);
      expect(r.expired).toBe(1);
      expect(invitaciones.vencerVencidas).toHaveBeenCalledWith(AHORA, 'd1');
      expect(notifier.cerrada).toHaveBeenCalledWith(
        { invitationId: 'v1' },
        'expired',
      );
    });

    it('dryRun calcula a quién invitaría sin escribir, vencer ni avisar', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 1)]);

      const r = await service.ejecutar('d1', AHORA, { dryRun: true });

      expect(r.invited).toBe(1);
      expect(r.expired).toBe(0);
      expect(r.candidates).toEqual([
        {
          userId: 'u1',
          fullName: 'Cliente u1',
          projectedDepletionAt: new Date(AHORA.getTime() + DIA),
          source: RepurchaseEstimateSource.HISTORY,
          items: [{ gasCylinderId: 'g10', quantity: 1 }],
        },
      ]);
      expect(invitaciones.abrir).not.toHaveBeenCalled();
      expect(invitaciones.vencerVencidas).not.toHaveBeenCalled();
      expect(notifier.invitar).not.toHaveBeenCalled();
    });

    it('es idempotente: la segunda corrida no vuelve a invitar a quien ya tiene una abierta', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 1)]);
      await service.ejecutar('d1', AHORA);
      invitaciones.ultimasPorCliente.mockResolvedValue(
        new Map([
          ['u1', ultima({ status: Estado.PENDING, respondedAt: null })],
        ]),
      );
      const segunda = await service.ejecutar('d1', AHORA);
      expect(segunda.invited).toBe(0);
      expect(invitaciones.abrir).toHaveBeenCalledTimes(1);
    });
  });

  describe('cerrarLasDeUnaDistribuidoraInactiva', () => {
    it('cierra sin efecto las abiertas y avisa a la app', async () => {
      const a = { invitationId: 'a', userId: 'u1' } as RepurchaseInvitation;
      const b = { invitationId: 'b', userId: 'u2' } as RepurchaseInvitation;
      invitaciones.abiertas.mockResolvedValue([a, b]);
      invitaciones.cancelar
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      expect(
        await service.cerrarLasDeUnaDistribuidoraInactiva('d9', AHORA),
      ).toBe(1);
      expect(invitaciones.abiertas).toHaveBeenCalledWith('d9');
      expect(notifier.cerrada).toHaveBeenCalledTimes(1);
      expect(notifier.cerrada).toHaveBeenCalledWith(a, 'cancelled');
    });
  });

  describe('vencer', () => {
    it('cierra sin efecto las abiertas a las que el cliente se adelantó y avisa', async () => {
      const adelantada = {
        invitationId: 'a',
        distributorId: 'd1',
        userId: 'u1',
        createdAt: AHORA,
      } as RepurchaseInvitation;
      const sigue = { ...adelantada, invitationId: 'b', userId: 'u2' };
      invitaciones.abiertas.mockResolvedValue([adelantada, sigue]);
      pedidos.hayPedidoDesde.mockImplementation((_d: string, u: string) =>
        Promise.resolve(u === 'u1'),
      );

      await service.vencer(AHORA, 'd1');

      expect(invitaciones.cancelar).toHaveBeenCalledTimes(1);
      expect(invitaciones.cancelar).toHaveBeenCalledWith('a', AHORA);
      expect(notifier.cerrada).toHaveBeenCalledWith(adelantada, 'cancelled');
    });

    it('no avisa si otra sentencia ya la había cerrado', async () => {
      invitaciones.abiertas.mockResolvedValue([
        { invitationId: 'a', distributorId: 'd1', userId: 'u1' },
      ]);
      pedidos.hayPedidoDesde.mockResolvedValue(true);
      invitaciones.cancelar.mockResolvedValue(false);
      await service.vencer(AHORA);
      expect(notifier.cerrada).not.toHaveBeenCalled();
    });

    it('devuelve cuántas venció', async () => {
      invitaciones.vencerVencidas.mockResolvedValue([
        { invitationId: 'x' },
        { invitationId: 'y' },
      ]);
      expect(await service.vencer(AHORA)).toBe(2);
    });
  });

  describe('aviso en la franja (M3b)', () => {
    const franja = (inicio: string) => ({
      ok: true,
      sugerencia: {
        ...sugerida.sugerencia,
        timeSlotId: 's1',
        timeSlotStart: inicio,
      },
    });

    it('con franja más tarde hoy, la invitación nace con notifyAt en su comienzo y no se avisa todavía', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 2)]);
      sugerencias.armar.mockResolvedValue(franja('18:00:00'));
      invitaciones.reclamarAviso.mockResolvedValue(false);

      await service.ejecutar('d1', AHORA);

      expect(invitaciones.abrir).toHaveBeenCalledWith(
        expect.objectContaining({
          notifyAt: new Date('2026-10-31T21:00:00Z'),
        }),
      );
      // El reclamo lo rechaza la base (la hora no llegó): nadie avisa.
      expect(notifier.invitar).not.toHaveBeenCalled();
    });

    it('sin franja, notifyAt es la hora de la corrida y se avisa en el acto', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 2)]);
      await service.ejecutar('d1', AHORA);
      expect(invitaciones.abrir).toHaveBeenCalledWith(
        expect.objectContaining({ notifyAt: AHORA }),
      );
      expect(invitaciones.reclamarAviso).toHaveBeenCalledWith('inv', AHORA);
      expect(notifier.invitar).toHaveBeenCalledTimes(1);
    });

    it('si la franja dejaría la invitación casi sin vigencia, avisa a la hora de la corrida', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 2)]);
      estimator.parametros.mockResolvedValue({
        ...PARAMS,
        invitationTtlHours: 10,
      });
      sugerencias.armar.mockResolvedValue(franja('18:00'));
      await service.ejecutar('d1', AHORA);
      const [datos] = invitaciones.abrir.mock.calls[0] as [
        { notifyAt: Date; expiresAt: Date },
      ];
      expect(datos.notifyAt).toEqual(AHORA);
      expect(datos.notifyAt.getTime()).toBeLessThan(datos.expiresAt.getTime());
    });

    it('guarda el ajuste del cliente en la invitación', async () => {
      estimator.estimar.mockResolvedValue([
        cliente('u1', 2, { offsetDays: 3 }),
      ]);
      await service.ejecutar('d1', AHORA);
      expect(invitaciones.abrir).toHaveBeenCalledWith(
        expect.objectContaining({ offsetDays: 3 }),
      );
    });

    it('la simulación no escribe ni avisa', async () => {
      estimator.estimar.mockResolvedValue([cliente('u1', 2)]);
      await service.ejecutar('d1', AHORA, { dryRun: true });
      expect(invitaciones.abrir).not.toHaveBeenCalled();
      expect(invitaciones.reclamarAviso).not.toHaveBeenCalled();
    });
  });

  describe('enviarAvisos', () => {
    const inv = (id: string) => ({ invitationId: id, userId: `u-${id}` });

    it('avisa de las que llegaron a su hora y cuenta cuántas', async () => {
      invitaciones.paraAvisar.mockResolvedValue([inv('a'), inv('b')]);
      expect(await service.enviarAvisos(AHORA, 'd1')).toBe(2);
      expect(invitaciones.paraAvisar).toHaveBeenCalledWith(AHORA, 'd1');
      expect(invitaciones.reclamarAviso).toHaveBeenCalledWith('a', AHORA);
      expect(notifier.invitar).toHaveBeenCalledTimes(2);
    });

    it('nunca dos avisos: si otra instancia ya reclamó la invitación, no manda nada', async () => {
      invitaciones.paraAvisar.mockResolvedValue([inv('a'), inv('b')]);
      invitaciones.reclamarAviso.mockImplementation((id: string) =>
        Promise.resolve(id === 'b'),
      );
      expect(await service.enviarAvisos(AHORA)).toBe(1);
      expect(notifier.invitar).toHaveBeenCalledTimes(1);
      expect(notifier.invitar).toHaveBeenCalledWith(inv('b'));
    });

    it('sin nada pendiente no avisa', async () => {
      expect(await service.enviarAvisos(AHORA)).toBe(0);
      expect(notifier.invitar).not.toHaveBeenCalled();
    });
  });
});
