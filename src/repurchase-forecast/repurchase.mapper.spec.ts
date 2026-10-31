import { Order, PaymentMethod } from '../order/entities/order.entity';
import { RepurchaseEstimateSource } from './domain/estimacion-de-recompra';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import { RecompraEstimada } from './repurchase-estimator.service';
import { DetalleDeInvitacion } from './repurchase-invitation-detail.service';
import { RepurchaseMapper } from './repurchase.mapper';

const AHORA = new Date('2026-10-31T12:00:00Z');

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    invitationId: 'i1',
    distributorId: 'd1',
    userId: 'u1',
    status: Estado.PENDING,
    projectedDepletionAt: new Date('2026-11-02T12:00:00Z'),
    estimateSource: RepurchaseEstimateSource.HISTORY,
    suggestedItems: [
      { gasCylinderId: 'g10', quantity: 2 },
      { gasCylinderId: 'gx', quantity: 1 },
    ],
    paymentMethod: PaymentMethod.CASH,
    expiresAt: new Date('2026-11-01T12:00:00Z'),
    createdAt: new Date('2026-10-31T09:00:00Z'),
    respondedAt: null,
    orderId: null,
    user: {
      fullName: 'Lucía',
      email: 'l@x.com',
      phoneNumber: '+54',
      customer: { customerId: 'c1' },
    },
    ...parcial,
  }) as RepurchaseInvitation;

const detalle = (): DetalleDeInvitacion => ({
  garrafas: new Map([
    [
      'g10',
      {
        gasCylinderId: 'g10',
        type: '10kg',
        price: 14900,
        isActive: true,
        stock: 5,
      },
    ],
  ]) as unknown as DetalleDeInvitacion['garrafas'],
  direccion: {
    addressId: 'a1',
    street: 'Jujuy 571',
    city: 'Posadas',
    formattedAddress: null,
  } as DetalleDeInvitacion['direccion'],
  franja: {
    timeSlotId: 't1',
    name: 'Tarde',
    startTime: '16:00:00',
    endTime: '20:00:00',
  } as DetalleDeInvitacion['franja'],
});

describe('RepurchaseMapper', () => {
  describe('invitation', () => {
    it('muestra el pedido precargado a precios de hoy', () => {
      const dto = RepurchaseMapper.invitation(invitacion(), detalle());
      expect(dto.items).toEqual([
        {
          gasCylinderId: 'g10',
          type: '10kg',
          quantity: 2,
          unitPrice: 14900,
          subtotal: 29800,
          available: true,
        },
        {
          gasCylinderId: 'gx',
          type: 'Producto no disponible',
          quantity: 1,
          unitPrice: 0,
          subtotal: 0,
          available: false,
        },
      ]);
      expect(dto.estimatedTotal).toBe(29800);
      expect(dto.address).toEqual({
        addressId: 'a1',
        label: 'Jujuy 571, Posadas',
      });
      expect(dto.timeSlot).toEqual({
        timeSlotId: 't1',
        name: 'Tarde',
        startTime: '16:00',
        endTime: '20:00',
      });
      expect(dto).toMatchObject({
        invitationId: 'i1',
        status: Estado.PENDING,
        paymentMethod: PaymentMethod.CASH,
        orderId: null,
      });
    });

    it('marca como no disponible lo que no alcanza de stock y usa la dirección formateada', () => {
      const d = detalle();
      d.garrafas.get('g10')!.stock = 1;
      d.direccion!.formattedAddress = 'Jujuy 571, Villa Cabello, Posadas';
      d.franja = null;
      const dto = RepurchaseMapper.invitation(invitacion(), d);
      expect(dto.items[0].available).toBe(false);
      expect(dto.address?.label).toBe('Jujuy 571, Villa Cabello, Posadas');
      expect(dto.timeSlot).toBeNull();
    });

    it('sin dirección sale en null', () => {
      const d = { ...detalle(), direccion: null };
      expect(RepurchaseMapper.invitation(invitacion(), d).address).toBeNull();
    });
  });

  it('accepted: el pedido sale con el contrato de pedidos y el enlace de cobro', () => {
    const order = {
      orderId: 'o1',
      distributorId: 'd1',
      orderItems: [],
      customer: undefined,
    } as unknown as Order;
    const invitation = RepurchaseMapper.invitation(invitacion(), detalle());
    const r = RepurchaseMapper.accepted(invitation, order, 'https://mp');
    expect(r.invitation).toBe(invitation);
    expect(r.order.id).toBe('o1');
    expect(r.order.paymentUrl).toBe('https://mp');
  });

  it('adminInvitation: el cliente, las garrafas y cómo terminó', () => {
    expect(RepurchaseMapper.adminInvitation(invitacion())).toEqual({
      invitationId: 'i1',
      status: Estado.PENDING,
      customer: {
        customerId: 'c1',
        userId: 'u1',
        fullName: 'Lucía',
        email: 'l@x.com',
        phoneNumber: '+54',
      },
      projectedDepletionAt: new Date('2026-11-02T12:00:00Z'),
      estimateSource: RepurchaseEstimateSource.HISTORY,
      totalUnits: 3,
      expiresAt: new Date('2026-11-01T12:00:00Z'),
      createdAt: new Date('2026-10-31T09:00:00Z'),
      respondedAt: null,
      orderId: null,
    });
  });

  it('adminInvitation: sin el cliente cargado, los datos salen en null', () => {
    const dto = RepurchaseMapper.adminInvitation(
      invitacion({ user: undefined as never }),
    );
    expect(dto.customer).toEqual({
      customerId: null,
      userId: 'u1',
      fullName: null,
      email: null,
      phoneNumber: null,
    });
  });

  describe('stats', () => {
    const resumen = (
      counts: Partial<Record<Estado, number>>,
      ingresos = 0,
    ) => ({
      counts: {
        pending: 0,
        accepted: 0,
        rejected: 0,
        expired: 0,
        cancelled: 0,
        ...counts,
      },
      acceptedRevenue: ingresos,
    });

    it('la conversión son las aceptadas sobre las resueltas; abiertas y canceladas no cuentan', () => {
      const s = RepurchaseMapper.stats(
        resumen(
          { accepted: 1, rejected: 1, expired: 1, pending: 4, cancelled: 2 },
          15800,
        ),
        AHORA,
        AHORA,
      );
      expect(s).toMatchObject({
        sent: 9,
        pending: 4,
        accepted: 1,
        rejected: 1,
        expired: 1,
        cancelled: 2,
        conversionRate: 0.3333,
        acceptedRevenue: 15800,
      });
    });

    it('sin resueltas no hay tasa', () => {
      expect(
        RepurchaseMapper.stats(resumen({ pending: 2 }), AHORA, AHORA)
          .conversionRate,
      ).toBeNull();
    });
  });

  describe('forecastRow', () => {
    const cliente = {
      customerId: 'c1',
      userId: 'u1',
      fullName: 'Lucía',
      email: 'l@x.com',
      phoneNumber: null,
      estimate: {
        ok: true,
        estimatedAt: new Date('2026-11-02T00:00:00Z'),
        source: RepurchaseEstimateSource.DECLARED,
        kgPerDay: 0.5,
        ordersUsed: 1,
        lastDeliveredAt: new Date('2026-10-20T00:00:00Z'),
        lastKg: 10.456,
      },
      habits: {
        items: [
          { gasCylinderId: 'g10', quantity: 2 },
          { gasCylinderId: 'g15', quantity: 1 },
        ],
      },
      declaredKgPerMonth: 15,
      noticeDays: 4,
      noticeEnabled: true,
    } as unknown as RecompraEstimada;

    it('arma la fila del listado con los días que faltan', () => {
      const fila = RepurchaseMapper.forecastRow(cliente, AHORA, null);
      expect(fila).toMatchObject({
        customer: {
          customerId: 'c1',
          userId: 'u1',
          fullName: 'Lucía',
          email: 'l@x.com',
        },
        daysLeft: 1.5,
        source: RepurchaseEstimateSource.DECLARED,
        lastPurchaseKg: 10.46,
        declaredKgPerMonth: 15,
        estimatedKgPerMonth: 15,
        usualUnits: 3,
        usualCylinderIds: ['g10', 'g15'],
        noticeDays: 4,
        openInvitation: null,
      });
    });

    it('con una invitación abierta la referencia', () => {
      const fila = RepurchaseMapper.forecastRow(cliente, AHORA, invitacion());
      expect(fila.openInvitation).toEqual({
        invitationId: 'i1',
        expiresAt: new Date('2026-11-01T12:00:00Z'),
      });
    });
  });

  describe('notice y mine', () => {
    it('los días que rigen son los propios o, sin elegir, los de la distribuidora', () => {
      expect(
        RepurchaseMapper.notice({
          enabled: true,
          days: null,
          distributorDays: 3,
        }),
      ).toEqual({
        enabled: true,
        days: null,
        distributorDays: 3,
        effectiveDays: 3,
      });
      expect(
        RepurchaseMapper.notice({
          enabled: false,
          days: 7,
          distributorDays: null,
        }),
      ).toEqual({
        enabled: false,
        days: 7,
        distributorDays: null,
        effectiveDays: 7,
      });
    });

    it('mine: sin estimación sale vacía con el motivo', () => {
      const r = RepurchaseMapper.mine(
        {
          estimacion: null,
          reason: 'no_purchases',
          aviso: { enabled: true, days: null, distributorDays: 3 },
          abierta: null,
        },
        AHORA,
      );
      expect(r).toMatchObject({
        estimatedAt: null,
        daysLeft: null,
        source: null,
        reason: 'no_purchases',
        openInvitation: null,
      });
    });

    it('mine: con estimación e invitación abierta', () => {
      const r = RepurchaseMapper.mine(
        {
          estimacion: {
            estimate: {
              estimatedAt: new Date('2026-11-02T12:00:00Z'),
              source: RepurchaseEstimateSource.HISTORY,
            },
          } as unknown as RecompraEstimada,
          reason: null,
          aviso: { enabled: true, days: 5, distributorDays: 3 },
          abierta: { invitacion: invitacion(), detalle: detalle() },
        },
        AHORA,
      );
      expect(r.daysLeft).toBe(2);
      expect(r.source).toBe(RepurchaseEstimateSource.HISTORY);
      expect(r.notice.effectiveDays).toBe(5);
      expect(r.openInvitation?.invitationId).toBe('i1');
    });
  });

  it('run: resume la corrida y las garrafas de cada candidato', () => {
    const r = RepurchaseMapper.run({
      evaluated: 5,
      invited: 1,
      expired: 2,
      skipped: {
        notice_disabled: 0,
        not_yet: 3,
        recent_order: 1,
        cooldown: 0,
        same_cycle: 0,
        no_stock: 0,
        no_address: 0,
      },
      candidates: [
        {
          userId: 'u1',
          fullName: 'Lucía',
          projectedDepletionAt: AHORA,
          source: RepurchaseEstimateSource.HISTORY,
          items: [
            { gasCylinderId: 'a', quantity: 2 },
            { gasCylinderId: 'b', quantity: 3 },
          ],
        },
      ],
    });
    expect(r.candidates).toEqual([
      {
        userId: 'u1',
        fullName: 'Lucía',
        projectedDepletionAt: AHORA,
        source: RepurchaseEstimateSource.HISTORY,
        totalUnits: 5,
      },
    ]);
    expect(r).toMatchObject({ evaluated: 5, invited: 1, expired: 2 });
    expect(r.skipped.not_yet).toBe(3);
  });
});
