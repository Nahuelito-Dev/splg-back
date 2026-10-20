import { EntityManager } from 'typeorm';
import { clientesDeEntrega, direccionDeEntrega } from './settlement-clientes';

const fila = {
  formatted_address: null,
  street: 'Av. Mitre 1200',
  city: 'Posadas',
  floor: null,
  apartment: null,
};

describe('direccionDeEntrega', () => {
  it('prefiere la dirección formateada', () => {
    expect(
      direccionDeEntrega({ ...fila, formatted_address: 'Mitre 1200, Posadas' }),
    ).toBe('Mitre 1200, Posadas');
  });

  it('agrega piso y depto a la dirección formateada', () => {
    expect(
      direccionDeEntrega({
        ...fila,
        formatted_address: 'Mitre 1200, Posadas',
        floor: '3',
        apartment: 'B',
      }),
    ).toBe('Mitre 1200, Posadas, piso 3 depto B');
  });

  it('recorta piso y depto y no muestra los vacíos', () => {
    expect(direccionDeEntrega({ ...fila, floor: ' 3 ', apartment: '  ' })).toBe(
      'Av. Mitre 1200, piso 3, Posadas',
    );
    expect(
      direccionDeEntrega({
        ...fila,
        formatted_address: 'Mitre 1200, Posadas',
        floor: ' ',
        apartment: '',
      }),
    ).toBe('Mitre 1200, Posadas');
  });

  it('arma calle, piso, depto y ciudad si no hay formateada', () => {
    expect(direccionDeEntrega({ ...fila, floor: '3', apartment: 'B' })).toBe(
      'Av. Mitre 1200, piso 3 depto B, Posadas',
    );
  });

  it('es null sin calle', () => {
    expect(direccionDeEntrega({ ...fila, street: null })).toBeNull();
  });
});

describe('clientesDeEntrega', () => {
  it('no consulta sin pedidos', async () => {
    const query = jest.fn();
    const r = await clientesDeEntrega(
      { query } as unknown as EntityManager,
      'd1',
      [],
    );
    expect(r.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('indexa nombre y dirección por pedido', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([
        { ...fila, order_id: 'o1', full_name: ' Ana Gómez ' },
      ]);
    const r = await clientesDeEntrega(
      { query } as unknown as EntityManager,
      'd1',
      ['o1'],
    );
    expect(r.get('o1')).toEqual({
      customerName: 'Ana Gómez',
      deliveryAddress: 'Av. Mitre 1200, Posadas',
    });
  });

  it('acota la consulta a la distribuidora', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await clientesDeEntrega({ query } as unknown as EntityManager, 'd1', [
      'o1',
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"distributor_id" = $1'),
      ['d1', ['o1']],
    );
  });
});
