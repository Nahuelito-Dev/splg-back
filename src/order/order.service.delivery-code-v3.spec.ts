import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { auditContext } from '../audit/data/audit-context';

/**
 * Código de entrega visto por el cliente (v3): sólo el dueño del pedido o un
 * admin, sólo aceptado / en camino. El cliente puede generar uno nuevo con el
 * pedido en camino; el chofer no ve ni genera nada.
 */
describe('OrderService · código de entrega del cliente (v3)', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000002';
  let orders: {
    replaceDeliveryCode: jest.Mock;
    upgradeLegacyDeliveryCode: jest.Mock;
  };
  let service: OrderService;

  const armar = (over: Partial<Order> = {}) => {
    orders = {
      replaceDeliveryCode: jest.fn().mockResolvedValue(true),
      upgradeLegacyDeliveryCode: jest.fn().mockResolvedValue(true),
    };
    service = new OrderService(
      {} as never,
      {} as never,
      {} as never,
      orders as never,
      ...(Array.from({ length: 13 }, () => ({})) as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({
      orderId: PEDIDO,
      customerId: 'cust-1',
      deliveryId: 'd-1',
      status: OrderStatus.ON_THE_WAY,
      deliveryCode: '482913',
      deliveryCodeAttempts: 2,
      ...over,
    } as unknown as Order);
  };

  describe('getDeliveryCodeParaElCliente', () => {
    it('el cliente dueño ve su código con los intentos', async () => {
      armar();
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).resolves.toEqual({
        orderId: PEDIDO,
        deliveryCode: '482913',
        attempts: 2,
        blocked: false,
      });
    });

    it('con 5 intentos figura bloqueado', async () => {
      armar({ deliveryCodeAttempts: 5 });
      const r = await service.getDeliveryCodeParaElCliente(
        PEDIDO,
        'cust-1',
        RoleType.CUSTOMER,
      );
      expect(r.blocked).toBe(true);
    });

    it('aceptado también lo ve', async () => {
      armar({ status: OrderStatus.ACCEPTED });
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).resolves.toMatchObject({ deliveryCode: '482913' });
    });

    it('un código viejo de 10 caracteres se cambia por uno de 6 dígitos con intentos en 0', async () => {
      armar({ deliveryCode: 'A1B2C3D4E5', deliveryCodeAttempts: 3 });
      const find = jest.spyOn(service, 'findOne');
      find.mockResolvedValueOnce({
        orderId: PEDIDO,
        customerId: 'cust-1',
        status: OrderStatus.ON_THE_WAY,
        deliveryCode: 'A1B2C3D4E5',
        deliveryCodeAttempts: 3,
      } as unknown as Order);
      find.mockResolvedValueOnce({
        orderId: PEDIDO,
        customerId: 'cust-1',
        status: OrderStatus.ON_THE_WAY,
        deliveryCode: '654321',
        deliveryCodeAttempts: 0,
      } as unknown as Order);
      const r = await service.getDeliveryCodeParaElCliente(
        PEDIDO,
        'cust-1',
        RoleType.CUSTOMER,
      );
      expect(orders.upgradeLegacyDeliveryCode).toHaveBeenCalledWith(
        PEDIDO,
        expect.stringMatching(/^\d{6}$/) as string,
      );
      expect(r).toEqual({
        orderId: PEDIDO,
        deliveryCode: '654321',
        attempts: 0,
        blocked: false,
      });
    });

    it('baja 3: en una sesión de soporte (sólo lectura) el GET no escribe: muestra el código viejo como está', async () => {
      armar({ deliveryCode: 'A1B2C3D4E5' });
      const r = await auditContext.run(
        {
          userId: 'super-1',
          ip: null,
          distributorId: 'dist-1',
          soporte: { alcance: [], vence: new Date(Date.now() + 60_000) },
        },
        () =>
          service.getDeliveryCodeParaElCliente(
            PEDIDO,
            'super-1',
            RoleType.SUPER_ADMIN,
          ),
      );
      expect(orders.upgradeLegacyDeliveryCode).not.toHaveBeenCalled();
      expect(r.deliveryCode).toBe('A1B2C3D4E5');
    });

    it.each([
      [OrderStatus.DELIVERED, 'El pedido ya se entregó'],
      [OrderStatus.CANCELLED, 'El pedido está cancelado'],
      [OrderStatus.PENDING, 'todavía no tiene un código'],
    ])('el 409 de un pedido %s lo dice con su texto', async (status, texto) => {
      armar({ status });
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'ORDER_WITHOUT_DELIVERY_CODE',
          message: expect.stringContaining(texto) as string,
        },
      });
    });

    it('un código de 6 dígitos no se toca', async () => {
      armar();
      await service.getDeliveryCodeParaElCliente(
        PEDIDO,
        'cust-1',
        RoleType.CUSTOMER,
      );
      expect(orders.upgradeLegacyDeliveryCode).not.toHaveBeenCalled();
    });

    it('con el pedido ya entregado no se cambia nada (409)', async () => {
      armar({ status: OrderStatus.DELIVERED, deliveryCode: 'A1B2C3D4E5' });
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toThrow(ConflictException);
      expect(orders.upgradeLegacyDeliveryCode).not.toHaveBeenCalled();
    });

    it('el pedido de otro cliente no existe para él (404)', async () => {
      armar();
      await expect(
        service.getDeliveryCodeParaElCliente(PEDIDO, 'otro', RoleType.CUSTOMER),
      ).rejects.toThrow(NotFoundException);
    });

    it('el chofer nunca lo ve (403)', async () => {
      armar();
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'u-chofer',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN])(
      '%s lo ve',
      async (role) => {
        armar();
        await expect(
          service.getDeliveryCodeParaElCliente(PEDIDO, 'x', role),
        ).resolves.toMatchObject({ deliveryCode: '482913' });
      },
    );

    it.each([
      OrderStatus.PENDING,
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
    ])('con el pedido %s: 409 ORDER_WITHOUT_DELIVERY_CODE', async (status) => {
      armar({ status });
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toMatchObject({
        response: { code: 'ORDER_WITHOUT_DELIVERY_CODE' },
      });
    });

    it('sin código guardado: 409', async () => {
      armar({ deliveryCode: null });
      await expect(
        service.getDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('regenerateDeliveryCodeParaElCliente', () => {
    it('el cliente dueño recibe un código de 6 dígitos con intentos en 0 y queda anotado quién lo generó', async () => {
      armar();
      const r = await service.regenerateDeliveryCodeParaElCliente(
        PEDIDO,
        'cust-1',
        RoleType.CUSTOMER,
      );
      expect(r.deliveryCode).toMatch(/^\d{6}$/);
      expect(r).toMatchObject({ attempts: 0, blocked: false });
      expect(orders.replaceDeliveryCode).toHaveBeenCalledWith(
        PEDIDO,
        r.deliveryCode,
        'el cliente',
      );
    });

    it('un admin también', async () => {
      armar();
      await service.regenerateDeliveryCodeParaElCliente(
        PEDIDO,
        'a-1',
        RoleType.ADMIN,
      );
      expect(orders.replaceDeliveryCode).toHaveBeenCalledWith(
        PEDIDO,
        expect.stringMatching(/^\d{6}$/) as string,
        'un administrador',
      );
    });

    it('el pedido de otro cliente: 404 y no se guarda nada', async () => {
      armar();
      await expect(
        service.regenerateDeliveryCodeParaElCliente(
          PEDIDO,
          'otro',
          RoleType.CUSTOMER,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(orders.replaceDeliveryCode).not.toHaveBeenCalled();
    });

    it('el chofer no puede (403)', async () => {
      armar();
      await expect(
        service.regenerateDeliveryCodeParaElCliente(
          PEDIDO,
          'u-c',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(orders.replaceDeliveryCode).not.toHaveBeenCalled();
    });

    it('sólo con el pedido en camino: aceptado responde 409 ORDER_NOT_ON_THE_WAY', async () => {
      armar({ status: OrderStatus.ACCEPTED });
      await expect(
        service.regenerateDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_ON_THE_WAY' } });
      expect(orders.replaceDeliveryCode).not.toHaveBeenCalled();
    });

    it('regenerar un pedido entregado: 409 que lo dice', async () => {
      armar({ status: OrderStatus.DELIVERED });
      await expect(
        service.regenerateDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'ORDER_NOT_ON_THE_WAY',
          message: 'El pedido ya se entregó: no hace falta otro código',
        },
      });
    });

    it('si dejó de estar en camino mientras tanto, 409', async () => {
      armar();
      orders.replaceDeliveryCode.mockResolvedValue(false);
      await expect(
        service.regenerateDeliveryCodeParaElCliente(
          PEDIDO,
          'cust-1',
          RoleType.CUSTOMER,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });
});
