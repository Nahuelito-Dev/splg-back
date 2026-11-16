import {
  mayorVentaPrimero,
  periodoAnterior,
  sumar,
  ticketPromedio,
} from './totales-de-ventas';

describe('totales de ventas', () => {
  it('suma con aritmética decimal, sin errores de punto flotante', () => {
    expect(sumar([0.1, 0.2])).toBe(0.3);
    expect(sumar([])).toBe(0);
  });

  it('el ticket promedio es ventas / pedidos a 2 decimales y 0 sin pedidos', () => {
    expect(ticketPromedio(100, 3)).toBe(33.33);
    expect(ticketPromedio(0, 0)).toBe(0);
  });

  it('ordena de mayor a menor venta sin tocar la lista original', () => {
    const filas = [{ totalSales: 1 }, { totalSales: 9 }, { totalSales: 5 }];
    expect(mayorVentaPrimero(filas, () => '').map((f) => f.totalSales)).toEqual(
      [9, 5, 1],
    );
    expect(filas[0].totalSales).toBe(1);
  });

  it('a igual venta desempata por nombre, así el orden es estable', () => {
    const filas = [
      { n: 'Zoe', totalSales: 10 },
      { n: 'Ana', totalSales: 10 },
      { n: 'Beto', totalSales: 20 },
    ];
    expect(mayorVentaPrimero(filas, (f) => f.n).map((f) => f.n)).toEqual([
      'Beto',
      'Ana',
      'Zoe',
    ]);
  });

  it('el período anterior tiene los mismos días y termina el día antes', () => {
    expect(periodoAnterior('2026-10-08', '2026-10-14')).toEqual({
      desde: '2026-10-01',
      hasta: '2026-10-07',
    });
    expect(periodoAnterior('2026-10-05', '2026-10-05')).toEqual({
      desde: '2026-10-04',
      hasta: '2026-10-04',
    });
  });
});
