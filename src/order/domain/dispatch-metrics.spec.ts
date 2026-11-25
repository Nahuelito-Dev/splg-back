import { AssignmentMethod } from '../entities/order.entity';
import { DispatchOfferStatus as S } from '../entities/dispatch-offer.entity';
import {
  calcularMetricasDeDespacho,
  mediana,
  OfertaMedida,
  percentil,
} from './dispatch-metrics';

const T0 = new Date('2026-11-10T12:00:00Z');
const en = (s: number) => new Date(T0.getTime() + s * 1000);
const oferta = (
  p: Partial<OfertaMedida> & Pick<OfertaMedida, 'status'>,
): OfertaMedida => ({
  orderId: 'o1',
  driverId: 'd1',
  driverName: 'Ana',
  offeredAt: T0,
  respondedAt: null,
  ...p,
});

describe('percentil y mediana', () => {
  it('interpola y devuelve null sin datos', () => {
    expect(mediana([])).toBeNull();
    expect(mediana([10, 2, 6])).toBe(6);
    expect(mediana([1, 2, 3, 4])).toBe(2.5);
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1);
  });
});

describe('calcularMetricasDeDespacho', () => {
  it('sin datos devuelve ceros y nulos, no NaN', () => {
    const m = calcularMetricasDeDespacho({
      metodosDeAsignacion: [],
      ofertas: [],
      pedidos: [],
      sinChofer: 0,
    });
    expect(m.pedidosDespachados).toBe(0);
    expect(m.ofertasPorPedido).toBeNull();
    expect(m.porcentajeAceptadas).toBeNull();
    expect(m.respuestaDelChofer).toEqual({ mediana: null, p90: null });
    expect(m.topChoferes).toEqual([]);
  });

  it('calcula porcentajes sobre las resueltas e ignora retiradas y abiertas', () => {
    const m = calcularMetricasDeDespacho({
      metodosDeAsignacion: [],
      ofertas: [
        oferta({ orderId: 'a', status: S.REJECTED, respondedAt: en(10) }),
        oferta({
          orderId: 'a',
          driverId: 'd2',
          driverName: 'Beto',
          status: S.EXPIRED,
        }),
        oferta({
          orderId: 'a',
          driverId: 'd3',
          driverName: 'Cami',
          status: S.ACCEPTED,
          respondedAt: en(20),
        }),
        oferta({ orderId: 'b', status: S.ACCEPTED, respondedAt: en(30) }),
        oferta({ orderId: 'b', driverId: 'd9', status: S.SUPERSEDED }),
        oferta({ orderId: 'c', driverId: 'd8', status: S.OFFERED }),
      ],
      pedidos: [
        { esperaDesde: T0, aceptadoEn: en(60) },
        { esperaDesde: T0, aceptadoEn: en(120) },
        { esperaDesde: T0, aceptadoEn: null },
      ],
      sinChofer: 2,
    });
    expect(m.pedidosDespachados).toBe(3);
    expect(m.ofertasPorPedido).toBe(1.7); // 5 intentos / 3 pedidos
    expect(m.porcentajeAceptadas).toBe(50);
    expect(m.porcentajeRechazadas).toBe(25);
    expect(m.porcentajeVencidas).toBe(25);
    // sólo las con respondedAt: 10, 20, 30
    expect(m.respuestaDelChofer.mediana).toBe(20);
    expect(m.respuestaDelChofer.p90).toBe(28);
    expect(m.hastaAsignar).toEqual({ mediana: 90, p90: 114 });
    expect(m.pedidosSinChofer).toBe(2);
  });

  it('arma el top por tasa de aceptación, máximo 5', () => {
    const ofertas: OfertaMedida[] = [];
    for (let i = 0; i < 7; i++) {
      ofertas.push(
        oferta({
          orderId: `p${i}`,
          driverId: `d${i}`,
          driverName: `Chofer ${i}`,
          status: i % 2 === 0 ? S.ACCEPTED : S.REJECTED,
          respondedAt: en(5 + i),
        }),
      );
    }
    ofertas.push(
      oferta({
        orderId: 'x',
        driverId: 'd0',
        driverName: 'Chofer 0',
        status: S.EXPIRED,
      }),
    );
    const { topChoferes } = calcularMetricasDeDespacho({
      metodosDeAsignacion: [],
      ofertas,
      pedidos: [],
      sinChofer: 0,
    });
    expect(topChoferes).toHaveLength(5);
    // d2, d4, d6 aceptaron 1 de 1 (100 %) y van antes que d0 (1 de 2).
    expect(topChoferes.slice(0, 3).map((c) => c.tasaAceptacion)).toEqual([
      100, 100, 100,
    ]);
    const d0 = topChoferes.find((c) => c.driverId === 'd0');
    expect(d0).toMatchObject({
      ofertas: 2,
      aceptadas: 1,
      tasaAceptacion: 50,
      medianaRespuestaSegundos: 5,
    });
  });
});

describe('calcularMetricasDeDespacho · método de asignación', () => {
  const vacia = { ofertas: [], pedidos: [], sinChofer: 0 };

  it('sin pedidos asignados: los cuatro métodos en cero y sin porcentaje', () => {
    const m = calcularMetricasDeDespacho({ ...vacia, metodosDeAsignacion: [] });
    expect(m.pedidosAsignados).toBe(0);
    expect(m.asignadosSinMetodo).toBe(0);
    expect(m.asignacionPorMetodo.map((x) => x.method)).toEqual([
      'automatic',
      'manual_override',
      'route_sheet',
      'batch',
    ]);
    expect(m.asignacionPorMetodo.every((x) => x.porcentaje === null)).toBe(
      true,
    );
  });

  it('el porcentaje es sobre los que tienen método; los viejos van aparte', () => {
    const m = calcularMetricasDeDespacho({
      ...vacia,
      metodosDeAsignacion: [
        AssignmentMethod.AUTOMATIC,
        AssignmentMethod.AUTOMATIC,
        AssignmentMethod.AUTOMATIC,
        AssignmentMethod.MANUAL_OVERRIDE,
        null,
        null,
      ],
    });
    expect(m.pedidosAsignados).toBe(6);
    expect(m.asignadosSinMetodo).toBe(2);
    const por = Object.fromEntries(
      m.asignacionPorMetodo.map((x) => [x.method, x]),
    );
    expect(por.automatic).toEqual({
      method: 'automatic',
      cantidad: 3,
      porcentaje: 75,
    });
    expect(por.manual_override.porcentaje).toBe(25);
    expect(por.route_sheet).toMatchObject({ cantidad: 0, porcentaje: 0 });
    expect(por.batch.cantidad).toBe(0);
  });
});
