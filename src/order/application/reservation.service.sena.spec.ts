import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { CashMethod } from '../../cash/domain/cash.enums';
import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { saldoACobrar } from '../../truck-load/domain/truck-load-rules';
import { ReservationService } from './reservation.service';

describe('ReservationService.confirmDeposit: la seña entra a una caja', () => {
  let order: Order;
  let asentarSena: jest.Mock;
  let avisarSinAsentar: jest.Mock;
  let cajaDelPago: jest.Mock;
  let service: ReservationService;

  const reserva = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      distributorId: 'd1',
      status: OrderStatus.RESERVED,
      paymentMethod: PaymentMethod.TRANSFER,
      totalAmount: 4500,
      depositAmount: 1000,
      depositPaid: false,
      depositPaidAt: null,
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    order = reserva();
    asentarSena = jest.fn().mockResolvedValue('asentado');
    avisarSinAsentar = jest.fn();
    cajaDelPago = jest.fn().mockResolvedValue(null);
    const manager = {
      findOne: jest.fn(() => Promise.resolve(order)),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    const repo = {
      manager: {
        transaction: (trabajo: (m: unknown) => unknown) => trabajo(manager),
      },
    };
    service = new ReservationService(
      repo as unknown as Repository<Order>,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { getOrThrow: jest.fn(() => 1) } as never,
      undefined as never,
      { asentarSena, avisarSinAsentar } as never,
      { cajaDelPago } as never,
    );
  });

  it('por transferencia entra a la caja de transferencias con el admin como autor', async () => {
    await service.confirmDeposit('ord-1', 'd1', 'adm-1');

    expect(asentarSena).toHaveBeenCalledWith(expect.anything(), {
      distributorId: 'd1',
      orderId: 'ord-1',
      amount: 1000,
      metodo: CashMethod.TRANSFER,
      userId: 'adm-1',
    });
    expect(avisarSinAsentar).toHaveBeenCalledWith('d1', 'asentado', 'ord-1');
  });

  it('sin caja de transferencias configurada la seña se confirma igual y se avisa', async () => {
    asentarSena.mockResolvedValue('sin_caja');

    const saved = await service.confirmDeposit('ord-1', 'd1', 'adm-1');

    expect(saved.depositPaid).toBe(true);
    expect(avisarSinAsentar).toHaveBeenCalledWith('d1', 'sin_caja', 'ord-1');
  });

  it('en efectivo entra a la caja de efectivo que eligió el admin', async () => {
    order = reserva({ paymentMethod: PaymentMethod.CASH });
    cajaDelPago.mockResolvedValue('cash-1');

    await service.confirmDeposit('ord-1', 'd1', 'adm-1', 'cash-1');

    expect(cajaDelPago).toHaveBeenCalledWith(expect.anything(), 'd1', 'cash-1');
    expect(asentarSena).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metodo: CashMethod.CASH, cashBoxId: 'cash-1' }),
    );
  });

  it('en efectivo sin la caja que exige la distribuidora es 400 y no confirma', async () => {
    order = reserva({ paymentMethod: PaymentMethod.CASH });
    cajaDelPago.mockRejectedValue(new BadRequestException('Indicá la caja'));

    await expect(
      service.confirmDeposit('ord-1', 'd1', 'adm-1'),
    ).rejects.toThrow(BadRequestException);
    expect(order.depositPaid).toBe(false);
  });

  it('en efectivo sin cajas de efectivo en la distribuidora se confirma sin movimiento', async () => {
    order = reserva({ paymentMethod: PaymentMethod.CASH });

    const saved = await service.confirmDeposit('ord-1', 'd1', 'adm-1');

    expect(saved.depositPaid).toBe(true);
    expect(asentarSena).not.toHaveBeenCalled();
  });

  it('si la caja elegida rechaza la seña en efectivo, 409 y no se confirma', async () => {
    order = reserva({ paymentMethod: PaymentMethod.CASH });
    cajaDelPago.mockResolvedValue('cash-1');
    asentarSena.mockResolvedValue('fallo');

    await expect(
      service.confirmDeposit('ord-1', 'd1', 'adm-1', 'cash-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('repetir la confirmación no asienta otra vez', async () => {
    order = reserva({ depositPaid: true });

    await service.confirmDeposit('ord-1', 'd1', 'adm-1');

    expect(asentarSena).not.toHaveBeenCalled();
    expect(avisarSinAsentar).not.toHaveBeenCalled();
  });

  it('la transferencia del saldo suma sólo el saldo: seña más saldo dan el total completo', () => {
    const sena = Number(order.depositAmount);
    const saldo = saldoACobrar(Number(order.totalAmount), sena);

    expect(saldo).toBe(3500);
    expect(sena + saldo).toBe(Number(order.totalAmount));
  });
});
