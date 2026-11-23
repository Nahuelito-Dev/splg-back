import type { GasCylinderPhotoService } from '../../gascylinder/gascylinder-photo.service';
import type { OrderResponseDto } from '../dto/order-response.dto';
import { OrderProductPhotoService } from './order-product-photo.service';

const renglon = (id: string | null) => ({
  cylinder: id ? { id, photoUrl: null as string | null } : null,
});

const pedido = (
  id: string,
  productos: Array<string | null>,
  distributorId = 'd1',
): OrderResponseDto =>
  ({
    id,
    distributorId,
    items: productos.map(renglon),
  }) as unknown as OrderResponseDto;

const fotosDe = (p: OrderResponseDto) =>
  p.items.map((i) => i.cylinder?.photoUrl ?? null);

describe('OrderProductPhotoService', () => {
  let productos: { urlsPorId: jest.Mock };
  let service: OrderProductPhotoService;

  beforeEach(() => {
    productos = { urlsPorId: jest.fn().mockResolvedValue(new Map()) };
    service = new OrderProductPhotoService(
      productos as unknown as GasCylinderPhotoService,
    );
  });

  it('con foto: cada renglón lleva la URL firmada de su producto', async () => {
    productos.urlsPorId.mockResolvedValue(
      new Map([
        ['g1', 'https://s3.test/g1.jpg'],
        ['g2', 'https://s3.test/g2.jpg'],
      ]),
    );
    const p = pedido('o1', ['g1', 'g2']);
    await service.completar([p]);
    expect(fotosDe(p)).toEqual([
      'https://s3.test/g1.jpg',
      'https://s3.test/g2.jpg',
    ]);
  });

  it('sin foto o firma caída (el producto viene null o no vuelve): photoUrl null y el pedido sigue', async () => {
    productos.urlsPorId.mockResolvedValue(new Map([['g1', null]]));
    const p = pedido('o1', ['g1', 'g9']);
    await service.completar([p]);
    expect(fotosDe(p)).toEqual([null, null]);
  });

  it('un renglón sin producto se deja como está', async () => {
    productos.urlsPorId.mockResolvedValue(
      new Map([['g1', 'https://s3.test/g1.jpg']]),
    );
    const p = pedido('o1', [null, 'g1']);
    await service.completar([p]);
    expect(p.items[0].cylinder).toBeNull();
    expect(p.items[1].cylinder?.photoUrl).toBe('https://s3.test/g1.jpg');
  });

  it('sin N+1: una sola lectura para toda la lista, con los ids sin repetir', async () => {
    productos.urlsPorId.mockResolvedValue(new Map());
    await service.completar([
      pedido('o1', ['g1', 'g2']),
      pedido('o2', ['g1']),
      pedido('o3', ['g2', 'g3']),
    ]);
    expect(productos.urlsPorId).toHaveBeenCalledTimes(1);
    const [distribuidora, ids] = productos.urlsPorId.mock.calls[0] as [
      string,
      Set<string>,
    ];
    expect(distribuidora).toBe('d1');
    expect([...ids].sort()).toEqual(['g1', 'g2', 'g3']);
  });

  it('aísla por distribuidora: un producto de otra empresa no aparece en el pedido ajeno', async () => {
    productos.urlsPorId.mockImplementation((distribuidora: string) =>
      Promise.resolve(
        distribuidora === 'd1'
          ? new Map([['g1', 'https://s3.test/d1-g1.jpg']])
          : new Map(),
      ),
    );
    const propio = pedido('o1', ['g1'], 'd1');
    const ajeno = pedido('o2', ['g1'], 'd2');
    await service.completar([propio, ajeno]);
    expect(fotosDe(propio)).toEqual(['https://s3.test/d1-g1.jpg']);
    expect(fotosDe(ajeno)).toEqual([null]);
  });

  it('sin renglones con producto no consulta nada', async () => {
    await service.completar([pedido('o1', []), pedido('o2', [null])]);
    expect(productos.urlsPorId).not.toHaveBeenCalled();
  });
});
