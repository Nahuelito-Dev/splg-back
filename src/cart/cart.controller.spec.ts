import { CartController } from './cart.controller';
import { CartService, CarritoConsultado } from './cart.service';
import { armarVista } from './domain/cart-view';
import { OrderPricingService } from '../order/domain/order-pricing.service';

describe('CartController', () => {
  const vacio: CarritoConsultado = {
    cart: null,
    vista: armarVista([], new OrderPricingService()),
  };
  let service: Record<
    'consultar' | 'agregarItem' | 'cambiarCantidad' | 'quitarItem' | 'vaciar',
    jest.Mock
  >;
  let controller: CartController;

  beforeEach(() => {
    service = {
      consultar: jest.fn().mockResolvedValue(vacio),
      agregarItem: jest.fn().mockResolvedValue(vacio),
      cambiarCantidad: jest.fn().mockResolvedValue(vacio),
      quitarItem: jest.fn().mockResolvedValue(vacio),
      vaciar: jest.fn().mockResolvedValue(vacio),
    };
    controller = new CartController(service as unknown as CartService);
  });

  it('el carrito vacío sale sin id y con total cero', async () => {
    await expect(controller.consultar('u1', 'd1')).resolves.toMatchObject({
      cartId: null,
      distributorId: 'd1',
      items: [],
      total: 0,
      updatedAt: null,
    });
  });

  it('el dueño sale siempre del token y la distribuidora del contexto', async () => {
    await controller.agregar({ gasCylinderId: 'g1', quantity: 2 }, 'u1', 'd1');
    await controller.cambiarCantidad('i1', { quantity: 3 }, 'u1', 'd1');
    await controller.quitar('i1', 'u1', 'd1');
    await controller.vaciar('u1', 'd1');

    expect(service.agregarItem).toHaveBeenCalledWith('u1', 'd1', 'g1', 2);
    expect(service.cambiarCantidad).toHaveBeenCalledWith('u1', 'd1', 'i1', 3);
    expect(service.quitarItem).toHaveBeenCalledWith('u1', 'd1', 'i1');
    expect(service.vaciar).toHaveBeenCalledWith('u1', 'd1');
  });
});
