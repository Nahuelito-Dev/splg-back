import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { validate } from 'class-validator';
import { ReleaseFraudHoldDto } from './dto/release-fraud-hold.dto';
import { OrderPaymentV2Controller } from './order-payment-v2.controller';

describe('OrderPaymentV2Controller', () => {
  let orders: { assertLegible: jest.Mock };
  let payments: {
    estadoDelPagoDelPedido: jest.Mock;
    estadosDelPagoDePedidos: jest.Mock;
  };
  let controller: OrderPaymentV2Controller;
  let fraudHold: { liberar: jest.Mock };
  const ID = '0b6c1c0e-6d0c-4a43-9d4e-5b1f2a7a1c11';
  const ID2 = '1b6c1c0e-6d0c-4a43-9d4e-5b1f2a7a1c12';
  const cliente = {
    role: RoleType.CUSTOMER,
    user_id: 'u-1',
  } as AuthenticatedUser;
  const admin = { role: RoleType.ADMIN, user_id: 'a-1' } as AuthenticatedUser;

  beforeEach(() => {
    orders = { assertLegible: jest.fn().mockResolvedValue(undefined) };
    payments = {
      estadoDelPagoDelPedido: jest.fn().mockResolvedValue({ orderId: ID }),
      estadosDelPagoDePedidos: jest.fn().mockResolvedValue([]),
    };
    fraudHold = {
      liberar: jest.fn().mockResolvedValue({ paymentFraudHold: false }),
    };
    controller = new OrderPaymentV2Controller(
      orders as never,
      payments as never,
      fraudHold as never,
    );
  });

  describe('GET :id/payment', () => {
    it('el cliente lee sólo sus pedidos y no recibe el historial', async () => {
      await controller.deUno(ID, cliente, null);

      expect(orders.assertLegible).toHaveBeenCalledWith(ID, null, 'u-1');
      expect(payments.estadoDelPagoDelPedido).toHaveBeenCalledWith(ID, false);
    });

    it('el staff lee los de su distribuidora y recibe el historial', async () => {
      await controller.deUno(ID, admin, 'dist-1');

      expect(orders.assertLegible).toHaveBeenCalledWith(
        ID,
        'dist-1',
        undefined,
      );
      expect(payments.estadoDelPagoDelPedido).toHaveBeenCalledWith(ID, true);
    });

    it('un pedido ajeno (404 del pedido) no llega a leer el pago', async () => {
      orders.assertLegible.mockRejectedValue(new NotFoundException());

      await expect(controller.deUno(ID, cliente, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(payments.estadoDelPagoDelPedido).not.toHaveBeenCalled();
    });
  });

  describe('GET payments (lista del panel)', () => {
    it('devuelve el estado de los pedidos legibles y se salta los ajenos sin error', async () => {
      orders.assertLegible.mockImplementation((id: string) =>
        id === ID2
          ? Promise.reject(new NotFoundException())
          : Promise.resolve(),
      );

      await controller.deVarios(`${ID}, ${ID2}`, 'dist-1');

      expect(payments.estadosDelPagoDePedidos).toHaveBeenCalledWith([ID]);
    });

    it('no repite ids', async () => {
      await controller.deVarios(`${ID},${ID}`, 'dist-1');

      expect(payments.estadosDelPagoDePedidos).toHaveBeenCalledWith([ID]);
    });

    it.each([undefined, '', ' , '])(
      'sin ids (%p) responde 400',
      async (ids) => {
        await expect(controller.deVarios(ids, 'dist-1')).rejects.toBeInstanceOf(
          BadRequestException,
        );
      },
    );

    it('un id que no es UUID responde 400', async () => {
      await expect(
        controller.deVarios(`${ID},no-es-uuid`, 'dist-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('más de 50 responde 400', async () => {
      const muchos = Array.from(
        { length: 51 },
        (_, i) =>
          `${i.toString(16).padStart(8, '0')}-6d0c-4a43-9d4e-5b1f2a7a1c11`,
      ).join(',');

      await expect(
        controller.deVarios(muchos, 'dist-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un error que no es 404 se propaga', async () => {
      orders.assertLegible.mockRejectedValue(new Error('base'));

      await expect(controller.deVarios(ID, 'dist-1')).rejects.toThrow('base');
    });
  });

  describe('M-1: liberar la retención por fraude', () => {
    it('delega con la distribuidora, el usuario y el motivo', async () => {
      await controller.liberarRetencion(
        ID,
        { reason: 'Verifiqué el pago con el cliente' },
        admin,
        'dist-1',
      );

      expect(fraudHold.liberar).toHaveBeenCalledWith(
        ID,
        'dist-1',
        'a-1',
        'Verifiqué el pago con el cliente',
      );
    });

    it('el motivo es obligatorio: 10 a 500 caracteres (el DTO lo valida)', async () => {
      const dto = (reason: string) =>
        Object.assign(new ReleaseFraudHoldDto(), { reason });

      expect(await validate(dto(''))).not.toHaveLength(0);
      expect(await validate(dto('corto'))).not.toHaveLength(0);
      expect(await validate(dto('x'.repeat(501)))).not.toHaveLength(0);
      expect(await validate(dto('Motivo suficiente'))).toHaveLength(0);
    });
  });
});
