import type { Repository } from 'typeorm';
import { ReservationService } from './reservation.service';
import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';

describe('ReservationService.findReservations', () => {
  const payments = {
    findPendingCheckoutUrls: jest.fn().mockResolvedValue(new Map()),
  };
  const orderRepository: {
    find: jest.Mock;
    findOne?: jest.Mock;
    save?: jest.Mock;
  } = { find: jest.fn() };
  const service = new ReservationService(
    orderRepository as unknown as Repository<Order>,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { getOrThrow: jest.fn(() => 1) } as never,
    payments as never,
  );

  const reserva = (extra: Partial<Order>) =>
    ({
      orderId: 'o1',
      status: OrderStatus.RESERVED,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 16700,
      depositAmount: 500,
      depositPaid: false,
      scheduledDate: '2026-10-31',
      createdAt: new Date('2026-10-21T20:00:00Z'),
      customer: { fullName: 'Ana', phoneNumber: '3764' },
      items: [],
      timeSlot: null,
      ...extra,
    }) as unknown as Order;

  it('trae la franja elegida con la hora en HH:MM y pide la relación', async () => {
    orderRepository.find.mockResolvedValue([
      reserva({
        timeSlot: {
          name: 'Mañana',
          startTime: '08:00:00',
          endTime: '12:00:00',
        } as Order['timeSlot'],
      }),
    ]);
    const [fila] = await service.findReservations('d1');
    expect(fila.timeSlot).toEqual({
      name: 'Mañana',
      startTime: '08:00',
      endTime: '12:00',
    });
    expect(orderRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        relations: expect.arrayContaining(['timeSlot']) as string[],
      }),
    );
  });

  it('una reserva sin franja trae timeSlot null', async () => {
    orderRepository.find.mockResolvedValue([reserva({})]);
    const [fila] = await service.findReservations('d1');
    expect(fila.timeSlot).toBeNull();
  });

  it('filtra por la distribuidora del que pide: la franja de otra distribuidora no sale', async () => {
    orderRepository.find.mockClear();
    orderRepository.find.mockResolvedValue([]);
    await service.findReservations('d1');
    expect(orderRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: OrderStatus.RESERVED,
          distributorId: 'd1',
        }) as Record<string, unknown>,
      }),
    );
  });

  it('confirmar la seña de una reserva por transferencia la marca cobrada, para que el cron la active', async () => {
    const order = reserva({ paymentMethod: PaymentMethod.TRANSFER });
    (order as { depositPaid: boolean }).depositPaid = false;
    orderRepository.findOne = jest.fn().mockResolvedValue(order);
    orderRepository.save = jest.fn((o: Order) => Promise.resolve(o));
    const saved = await service.confirmDeposit('o1', 'd1');
    expect(saved.depositPaid).toBe(true);
  });

  it('una seña por MercadoPago pendiente trae su enlace de pago; efectivo y seña paga, no', async () => {
    payments.findPendingCheckoutUrls.mockClear();
    payments.findPendingCheckoutUrls.mockResolvedValue(
      new Map([['mp1', 'https://mp.test/checkout/1']]),
    );
    orderRepository.find.mockResolvedValue([
      reserva({ orderId: 'mp1', paymentMethod: PaymentMethod.MERCADOPAGO }),
      reserva({ orderId: 'ef1', paymentMethod: PaymentMethod.CASH }),
      reserva({
        orderId: 'mp2',
        paymentMethod: PaymentMethod.MERCADOPAGO,
        depositPaid: true,
      }),
    ]);
    const filas = await service.findReservations('d1');
    expect(payments.findPendingCheckoutUrls).toHaveBeenCalledWith(['mp1']);
    expect(filas.map((f) => f.paymentUrl)).toEqual([
      'https://mp.test/checkout/1',
      null,
      null,
    ]);
  });

  it('la seña de MercadoPago no se confirma a mano: la marca cobrada el aviso de la pasarela', async () => {
    const order = reserva({ paymentMethod: PaymentMethod.MERCADOPAGO });
    orderRepository.findOne = jest.fn().mockResolvedValue(order);
    orderRepository.save = jest.fn((o: Order) => Promise.resolve(o));
    await expect(service.confirmDeposit('o1', 'd1')).rejects.toThrow(
      /se confirma sola cuando la pasarela avisa el pago/,
    );
    expect(orderRepository.save).not.toHaveBeenCalled();
  });
});
