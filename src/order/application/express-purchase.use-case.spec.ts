import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExpressPurchaseUseCase } from './express-purchase.use-case';
import { RoleType } from '../../common/constants/role-type.enum';
import { OrderDeliveryMode, PaymentMethod } from '../entities/order.entity';

describe('ExpressPurchaseUseCase (CU-147)', () => {
  let habitual: { gasCylinderId: string } | undefined;
  let consulta: Record<string, jest.Mock>;
  let addresses: { findDefaultByUserId: jest.Mock };
  let express: { evaluar: jest.Mock };
  let quote: { execute: jest.Mock };
  let create: { execute: jest.Mock };
  let distributors: { getDefault: jest.Mock };
  let useCase: ExpressPurchaseUseCase;

  const direccion = {
    addressId: 'dir-1',
    street: 'Av. Siempre Viva 742',
    city: 'Posadas',
  };

  beforeEach(() => {
    habitual = { gasCylinderId: 'gc-habitual' };
    consulta = {};
    for (const m of [
      'innerJoin',
      'select',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
    ]) {
      consulta[m] = jest.fn().mockReturnValue(consulta);
    }
    consulta.getRawOne = jest.fn(() => Promise.resolve(habitual));
    addresses = { findDefaultByUserId: jest.fn().mockResolvedValue(direccion) };
    express = {
      evaluar: jest.fn().mockResolvedValue({
        available: true,
        reason: null,
        message: null,
        settings: { estimatedMinutes: 40 },
      }),
    };
    quote = { execute: jest.fn().mockResolvedValue({ total: 11500 }) };
    create = {
      execute: jest.fn().mockResolvedValue({ order: { orderId: 'ord-1' } }),
    };
    distributors = {
      getDefault: jest.fn().mockResolvedValue({ distributorId: 'dist-def' }),
    };
    useCase = new ExpressPurchaseUseCase(
      {
        manager: { createQueryBuilder: jest.fn(() => consulta) },
      } as never,
      addresses as never,
      express as never,
      quote as never,
      create as never,
      distributors as never,
    );
  });

  describe('preview', () => {
    it('con la dirección predeterminada y la garrafa habitual muestra el precio con el recargo', async () => {
      const r = await useCase.preview(
        { paymentMethod: PaymentMethod.CASH },
        'cli-1',
        'dist-1',
      );

      expect(r).toMatchObject({
        available: true,
        fallback: null,
        address: direccion,
        item: { gasCylinderId: 'gc-habitual', quantity: 1 },
        quote: { total: 11500 },
        estimatedMinutes: 40,
      });
      expect(addresses.findDefaultByUserId).toHaveBeenCalledWith(
        'cli-1',
        'cli-1',
      );
      expect(quote.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cli-1',
          addressId: 'dir-1',
          deliveryMode: OrderDeliveryMode.EXPRESS,
          items: [{ gasCylinderId: 'gc-habitual', quantity: 1, unitPrice: 0 }],
        }),
        'dist-1',
        { userId: 'cli-1', role: RoleType.CUSTOMER },
      );
    });

    it('sin cobertura, horario o moto ofrece el flujo con franja horaria y no cotiza', async () => {
      express.evaluar.mockResolvedValue({
        available: false,
        reason: 'no_motorcycle_driver',
        message: 'No hay un chofer en moto disponible cerca',
        settings: { estimatedMinutes: 40 },
      });

      const r = await useCase.preview(
        { paymentMethod: PaymentMethod.CASH },
        'cli-1',
        'dist-1',
      );

      expect(r).toMatchObject({
        available: false,
        reason: 'no_motorcycle_driver',
        fallback: 'scheduled',
        quote: null,
        estimatedMinutes: null,
      });
      expect(quote.execute).not.toHaveBeenCalled();
    });

    it('la garrafa y la cantidad que manda el cliente pisan la habitual', async () => {
      const r = await useCase.preview(
        {
          paymentMethod: PaymentMethod.CASH,
          gasCylinderId: 'gc-otra',
          quantity: 2,
        },
        'cli-1',
        'dist-1',
      );

      expect(r.item).toEqual({ gasCylinderId: 'gc-otra', quantity: 2 });
      expect(consulta.getRawOne).not.toHaveBeenCalled();
    });

    it('sin dirección predeterminada: 404 para que elija una', async () => {
      addresses.findDefaultByUserId.mockRejectedValue(
        new NotFoundException('No addresses found for user: cli-1'),
      );

      await expect(
        useCase.preview(
          { paymentMethod: PaymentMethod.CASH },
          'cli-1',
          'dist-1',
        ),
      ).rejects.toThrow(/dirección predeterminada/);
    });

    it('otro error al buscar la dirección se propaga tal cual', async () => {
      addresses.findDefaultByUserId.mockRejectedValue(new Error('db'));

      await expect(
        useCase.preview(
          { paymentMethod: PaymentMethod.CASH },
          'cli-1',
          'dist-1',
        ),
      ).rejects.toThrow('db');
    });

    it('sin compras previas ni gasCylinderId: 400', async () => {
      habitual = undefined;

      await expect(
        useCase.preview(
          { paymentMethod: PaymentMethod.CASH },
          'cli-1',
          'dist-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('cliente sin X-Distributor: distribuidora por defecto; sin ninguna, 400', async () => {
      await useCase.preview(
        { paymentMethod: PaymentMethod.CASH },
        'cli-1',
        null,
      );
      expect(express.evaluar).toHaveBeenCalledWith('dist-def', direccion);

      distributors.getDefault.mockResolvedValue(null);
      await expect(
        useCase.preview({ paymentMethod: PaymentMethod.CASH }, 'cli-1', null),
      ).rejects.toThrow(/X-Distributor/);
    });
  });

  describe('buy', () => {
    it('crea el pedido en modalidad express con la dirección y la garrafa resueltas', async () => {
      const r = await useCase.buy(
        { paymentMethod: PaymentMethod.TRANSFER, notificationToken: 'tok' },
        'cli-1',
        'dist-1',
      );

      expect(r).toEqual({ order: { orderId: 'ord-1' } });
      expect(create.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cli-1',
          addressId: 'dir-1',
          paymentMethod: PaymentMethod.TRANSFER,
          notificationToken: 'tok',
          deliveryMode: OrderDeliveryMode.EXPRESS,
          items: [{ gasCylinderId: 'gc-habitual', quantity: 1, unitPrice: 0 }],
        }),
        'dist-1',
      );
    });

    it('el 409 de "ya no hay moto" lo da el alta y llega tal cual', async () => {
      create.execute.mockRejectedValue(new Error('EXPRESS_NOT_AVAILABLE'));

      await expect(
        useCase.buy({ paymentMethod: PaymentMethod.CASH }, 'cli-1', 'dist-1'),
      ).rejects.toThrow('EXPRESS_NOT_AVAILABLE');
    });
  });
});
