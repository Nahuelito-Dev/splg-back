import { OrderController } from './order.controller';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

const usuario = (role: RoleType) =>
  ({ user_id: 'u1', role }) as unknown as AuthenticatedUser;

describe('OrderController · GET /orders/available y los pedidos express', () => {
  let orderService: { findAvailableOrders: jest.Mock };
  let truckLoadGate: { motivoParaNoRecibir: jest.Mock };
  let controller: OrderController;

  beforeEach(() => {
    orderService = {
      findAvailableOrders: jest.fn().mockResolvedValue({
        orders: [],
        total: 0,
        limit: 10,
        offset: 0,
      }),
    };
    truckLoadGate = { motivoParaNoRecibir: jest.fn().mockResolvedValue(null) };
    controller = new OrderController(
      orderService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      truckLoadGate as never,
      {} as never,
      {} as never,
      {} as never,
      { completar: jest.fn() } as never,
      { completar: jest.fn() } as never,
    );
  });

  it('el chofer no ve los express: son de las motos que reciben la oferta', async () => {
    await controller.findAvailableOrders({}, 'd1', usuario(RoleType.DELIVERY));

    expect(orderService.findAvailableOrders).toHaveBeenCalledWith(
      {},
      'd1',
      false,
    );
  });

  it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN])(
    '%s sí los ve en el pool',
    async (rol) => {
      await controller.findAvailableOrders({}, 'd1', usuario(rol));

      expect(orderService.findAvailableOrders).toHaveBeenCalledWith(
        {},
        'd1',
        true,
      );
    },
  );
});
