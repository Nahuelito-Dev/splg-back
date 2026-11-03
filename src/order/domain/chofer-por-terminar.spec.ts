import { OrderStatus } from '../entities/order.entity';
import {
  distanciaEnMetros,
  posicionReciente,
  situacionDelChofer,
  type PedidoEnCursoDeChofer,
} from './chofer-por-terminar';

describe('situacionDelChofer (CU-013)', () => {
  const DESTINO = { lat: -26.9, lng: -65.3 };
  // ~111 m al este y ~1,1 km al sur del destino.
  const CERCA = { lat: -26.9, lng: -65.299 };
  const LEJOS = { lat: -26.91, lng: -65.3 };

  const pedido = (
    status: OrderStatus,
    destino: PedidoEnCursoDeChofer['destino'] = DESTINO,
  ): PedidoEnCursoDeChofer => ({ orderId: 'o', status, destino });

  it('sin pedidos en curso está libre, con o sin posición', () => {
    expect(situacionDelChofer([], null, 300)).toBe('libre');
    expect(situacionDelChofer([], LEJOS, 0)).toBe('libre');
  });

  it('en camino y dentro del radio de su destino: por terminar', () => {
    expect(
      situacionDelChofer([pedido(OrderStatus.ON_THE_WAY)], CERCA, 300),
    ).toBe('por_terminar');
  });

  it('en camino pero fuera del radio: ocupado', () => {
    expect(
      situacionDelChofer([pedido(OrderStatus.ON_THE_WAY)], LEJOS, 300),
    ).toBe('ocupado');
  });

  it('el límite del radio es inclusivo', () => {
    const d = distanciaEnMetros(CERCA, DESTINO);
    expect(situacionDelChofer([pedido(OrderStatus.ON_THE_WAY)], CERCA, d)).toBe(
      'por_terminar',
    );
    expect(
      situacionDelChofer([pedido(OrderStatus.ON_THE_WAY)], CERCA, d - 1),
    ).toBe('ocupado');
  });

  it('radio 0 apaga la regla: ocupado aunque esté encima del destino', () => {
    expect(
      situacionDelChofer([pedido(OrderStatus.ON_THE_WAY)], DESTINO, 0),
    ).toBe('ocupado');
  });

  it('con dos pedidos en curso es ocupado, esté donde esté', () => {
    expect(
      situacionDelChofer(
        [pedido(OrderStatus.ON_THE_WAY), pedido(OrderStatus.ACCEPTED)],
        CERCA,
        300,
      ),
    ).toBe('ocupado');
  });

  it('un pedido aceptado que todavía no salió no cuenta como por terminar', () => {
    expect(situacionDelChofer([pedido(OrderStatus.ACCEPTED)], CERCA, 300)).toBe(
      'ocupado',
    );
  });

  it('sin posición conocida o sin punto de entrega no es candidato', () => {
    expect(
      situacionDelChofer([pedido(OrderStatus.ON_THE_WAY)], null, 300),
    ).toBe('ocupado');
    expect(
      situacionDelChofer([pedido(OrderStatus.ON_THE_WAY, null)], CERCA, 300),
    ).toBe('ocupado');
  });
});

describe('posicionReciente', () => {
  const ahora = Date.parse('2026-11-02T12:00:00Z');
  it('vale hasta 2 minutos; más viejo o sin fecha, no', () => {
    expect(posicionReciente('2026-11-02T11:58:00Z', ahora)).toBe(true);
    expect(posicionReciente('2026-11-02T11:57:59Z', ahora)).toBe(false);
    expect(posicionReciente('2026-11-02T12:00:20Z', ahora)).toBe(true);
    expect(posicionReciente('2026-11-02T12:00:31Z', ahora)).toBe(false);
    expect(posicionReciente(null, ahora)).toBe(false);
    expect(posicionReciente('basura', ahora)).toBe(false);
  });
});
