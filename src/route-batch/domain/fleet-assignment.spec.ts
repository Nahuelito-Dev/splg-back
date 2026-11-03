import {
  FleetOrder,
  FleetParams,
  FleetPlan,
  FleetVehicle,
  planFleet,
  sweepOrder,
} from './fleet-assignment';
import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { computeSchedule } from './eta';
import { SIN_CARGA, StopLoad } from './load-profile';
import { matrixOf, MIN, permutations, seeded, T0, XY } from './route-fixtures';

const DEPOSITO: XY = { x: 0, y: 0 };
const CENTRO = { lat: 0, lng: 0 };

const carga = (kg: number, units = 1): StopLoad => ({
  ...SIN_CARGA,
  deliverKg: kg,
  deliverUnits: units,
});

interface PedidoSpec {
  id: string;
  at: XY | null;
  kg?: number;
  units?: number;
  window?: [number, number];
  load?: StopLoad;
}

/** Arma los pedidos y los parámetros desde puntos del plano (el depósito es la fila 0). */
function escenario(
  pedidos: readonly PedidoSpec[],
  extra: Partial<FleetParams> = {},
) {
  const puntos: XY[] = [DEPOSITO];
  const orders: FleetOrder[] = pedidos.map((p, i) => {
    let point: number | null = null;
    if (p.at) {
      puntos.push(p.at);
      point = puntos.length - 1;
    }
    const [ini, fin] = p.window ?? [0, 100_000];
    return {
      id: p.id,
      point,
      lat: p.at ? p.at.y : null,
      lng: p.at ? p.at.x : null,
      windowStartMs: T0 + ini * MIN,
      windowEndMs: T0 + fin * MIN,
      createdAtMs: T0 - (i + 1) * 1000,
      load: p.load ?? carga(p.kg ?? 10, p.units ?? 1),
    };
  });
  const params: FleetParams = {
    schedule: {
      matrix: matrixOf(puntos),
      originPoint: 0,
      startMs: T0,
      serviceMinutes: 10,
    },
    depot: { lat: 0, lng: 0 },
    maxStopsPerSheet: 20,
    ...extra,
  };
  return { orders, params };
}

const vehiculo = (
  id: string,
  capacityKg: number | null = null,
  capacityUnits: number | null = null,
): FleetVehicle => ({ id, capacityKg, capacityUnits });

const asignados = (plan: FleetPlan): string[] =>
  plan.sheets.flatMap((s) => s.orderIds).sort();
const hojaDe = (plan: FleetPlan, orderId: string) =>
  plan.sheets.find((s) => s.orderIds.includes(orderId))?.vehicleId;

describe('sweepOrder', () => {
  const pedido = (id: string, x: number, y: number): FleetOrder =>
    escenario([{ id, at: { x, y } }]).orders[0];

  it('ordena por ángulo alrededor del depósito, empezando después del mayor hueco', () => {
    // Ángulos: este (0°), norte (90°), oeste (180°), y uno al sur-oeste (-135°).
    const orden = sweepOrder(
      [
        pedido('oeste', -5, 0),
        pedido('este', 5, 0),
        pedido('norte', 0, 5),
        pedido('sudoeste', -5, -5),
      ],
      CENTRO,
    ).map((o) => o.id);
    // El hueco más grande es el de -135° a 0° (135°): se arranca en el este.
    expect(orden).toEqual(['este', 'norte', 'oeste', 'sudoeste']);
  });

  it('una nube compacta no se corta por la mitad', () => {
    // Todos al este con ángulos cerca de 0, uno apenas bajo el eje y otro apenas sobre él.
    const orden = sweepOrder(
      [pedido('b', 5, 0.2), pedido('a', 5, -0.2), pedido('c', 5, 0)],
      CENTRO,
    ).map((o) => o.id);
    expect(orden).toEqual(['a', 'c', 'b']);
  });

  it('con un solo pedido o ninguno devuelve lo mismo', () => {
    expect(sweepOrder([], CENTRO)).toEqual([]);
    expect(sweepOrder([pedido('x', 1, 1)], CENTRO).map((o) => o.id)).toEqual([
      'x',
    ]);
  });

  it('desempata dos pedidos en el mismo ángulo por franja y por id', () => {
    const a = pedido('b', 5, 5);
    const b = pedido('a', 10, 10);
    expect(sweepOrder([a, b], CENTRO).map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('planFleet', () => {
  describe('reparto', () => {
    it('cada vehículo se queda con su zona: norte y sur van en hojas distintas', () => {
      const { orders, params } = escenario([
        { id: 'n1', at: { x: 0, y: 8 } },
        { id: 's1', at: { x: 0, y: -8 } },
        { id: 'n2', at: { x: 1, y: 9 } },
        { id: 's2', at: { x: 1, y: -9 } },
        { id: 'n3', at: { x: -1, y: 10 } },
        { id: 's3', at: { x: -1, y: -10 } },
      ]);
      const plan = planFleet(
        orders,
        [vehiculo('v1', 30), vehiculo('v2', 30)],
        params,
      );
      expect(plan.unassigned).toEqual([]);
      expect(plan.sheets).toHaveLength(2);
      const norte = new Set(['n1', 'n2', 'n3']);
      for (const hoja of plan.sheets) {
        const alNorte = hoja.orderIds.filter((id) => norte.has(id)).length;
        expect(alNorte === 0 || alNorte === 3).toBe(true);
      }
      expect(hojaDe(plan, 'n1')).toBe(hojaDe(plan, 'n3'));
      expect(hojaDe(plan, 's1')).not.toBe(hojaDe(plan, 'n1'));
    });

    it('con un solo vehículo y capacidad de sobra, todo va en una hoja ordenada', () => {
      const { orders, params } = escenario([
        { id: 'c', at: { x: 9, y: 0 } },
        { id: 'a', at: { x: 3, y: 0 } },
        { id: 'b', at: { x: 6, y: 0 } },
      ]);
      const plan = planFleet(orders, [vehiculo('v1', null)], params);
      expect(plan.sheets).toHaveLength(1);
      expect(plan.sheets[0].orderIds).toEqual(['a', 'b', 'c']);
      expect(plan.sheets[0].schedule.feasible).toBe(true);
      expect(plan.sheets[0].totalUnits).toBe(3);
      expect(plan.sheets[0].totalKg).toBe(30);
    });

    it('no usa vehículos de más: una hoja vacía no se devuelve', () => {
      const { orders, params } = escenario([{ id: 'a', at: { x: 3, y: 0 } }]);
      const plan = planFleet(
        orders,
        [vehiculo('v1'), vehiculo('v2'), vehiculo('v3')],
        params,
      );
      expect(plan.sheets.map((s) => s.vehicleId)).toEqual(['v1']);
    });

    it('sin pedidos no hay hojas ni pendientes', () => {
      const { params } = escenario([]);
      expect(planFleet([], [vehiculo('v1')], params)).toEqual({
        sheets: [],
        unassigned: [],
        relocations: 0,
      });
    });

    it('cada pedido queda en exactamente una hoja o sin asignar', () => {
      const azar = seeded(7);
      const { orders, params } = escenario(
        Array.from({ length: 40 }, (_, i) => ({
          id: `p${String(i).padStart(2, '0')}`,
          at: { x: (azar() - 0.5) * 30, y: (azar() - 0.5) * 30 },
          kg: 10 + Math.floor(azar() * 20),
        })),
      );
      const plan = planFleet(
        orders,
        [vehiculo('v1', 150), vehiculo('v2', 150), vehiculo('v3', 150)],
        params,
      );
      const todos = [
        ...asignados(plan),
        ...plan.unassigned.map((u) => u.orderId),
      ].sort();
      expect(todos).toEqual(orders.map((o) => o.id).sort());
      for (const hoja of plan.sheets) {
        expect(hoja.schedule.lateCount).toBe(0);
        expect(hoja.totalKg).toBeLessThanOrEqual(150);
      }
    });
  });

  describe('capacidad', () => {
    const siete = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      at: { x: 2 + i, y: 0 },
      kg: 10,
    }));

    it('nunca pasa un vehículo de sus kilos: lo que sobra queda sin asignar por capacidad', () => {
      const { orders, params } = escenario(siete);
      const plan = planFleet(
        orders,
        [vehiculo('v1', 30), vehiculo('v2', 30)],
        params,
      );
      expect(plan.sheets.every((s) => s.totalKg <= 30)).toBe(true);
      expect(asignados(plan)).toHaveLength(6);
      expect(plan.unassigned).toHaveLength(1);
      expect(plan.unassigned[0].reason).toBe('capacity');
    });

    it('las garrafas son un tope aparte de los kilos', () => {
      const { orders, params } = escenario(
        siete.map((p) => ({ ...p, kg: 1, units: 2 })),
      );
      const plan = planFleet(
        orders,
        [vehiculo('v1', 1000, 6), vehiculo('v2', 1000, 6)],
        params,
      );
      expect(plan.sheets.every((s) => s.totalUnits <= 6)).toBe(true);
      expect(asignados(plan)).toHaveLength(6);
      expect(plan.unassigned.map((u) => u.reason)).toEqual(['capacity']);
    });

    it('un pedido que no entra solo en ningún vehículo queda sin asignar y no traba a los demás', () => {
      const { orders, params } = escenario([
        { id: 'enorme', at: { x: 3, y: 0 }, kg: 500 },
        { id: 'a', at: { x: 4, y: 0 }, kg: 10 },
        { id: 'b', at: { x: 5, y: 0 }, kg: 10 },
      ]);
      const plan = planFleet(orders, [vehiculo('v1', 100)], params);
      expect(plan.unassigned).toEqual([
        { orderId: 'enorme', reason: 'capacity' },
      ]);
      expect(asignados(plan)).toEqual(['a', 'b']);
    });

    it('un pedido grande va al vehículo grande aunque el chico sea el primero de la lista', () => {
      const { orders, params } = escenario([
        { id: 'grande', at: { x: 3, y: 0 }, kg: 80 },
      ]);
      const plan = planFleet(
        orders,
        [vehiculo('chico', 50), vehiculo('grande', 100)],
        params,
      );
      expect(hojaDe(plan, 'grande')).toBe('grande');
    });

    it('el pico de unidades depende del orden: si retirar primero pasa el tope, se entrega antes de retirar', () => {
      const retiro: StopLoad = { ...SIN_CARGA, pickupUnits: 6, pickupKg: 72 };
      const { orders, params } = escenario([
        { id: 'r', at: { x: 3, y: 0 }, load: retiro },
        { id: 'a', at: { x: 4, y: 0 }, load: carga(10, 2) },
      ]);
      // Por cercanía iría r primero: 2 llenas + 6 retiradas = 8 a bordo. El tope es 7.
      const plan = planFleet(orders, [vehiculo('v1', null, 7)], params);
      expect(plan.unassigned).toEqual([]);
      expect(plan.sheets[0].orderIds).toEqual(['a', 'r']);
      expect(plan.sheets[0].peakUnits).toBe(6);
    });

    it('un retiro que por sí solo pasa el tope del vehículo queda sin asignar por capacidad', () => {
      const retiro: StopLoad = { ...SIN_CARGA, pickupUnits: 8, pickupKg: 96 };
      const { orders, params } = escenario([
        { id: 'r', at: { x: 3, y: 0 }, load: retiro },
        { id: 'a', at: { x: 4, y: 0 }, load: carga(10, 2) },
      ]);
      const plan = planFleet(orders, [vehiculo('v1', null, 7)], params);
      expect(plan.unassigned).toEqual([{ orderId: 'r', reason: 'capacity' }]);
      expect(asignados(plan)).toEqual(['a']);
    });

    it('sin capacidad cargada no hay tope (sólo el máximo de paradas)', () => {
      const { orders, params } = escenario(
        Array.from({ length: 30 }, (_, i) => ({
          id: `p${String(i).padStart(2, '0')}`,
          at: { x: 1 + i * 0.1, y: 0 },
          kg: 999,
        })),
        { maxStopsPerSheet: 30 },
      );
      expect(
        planFleet(orders, [vehiculo('v1', null, null)], params).sheets[0]
          .orderIds,
      ).toHaveLength(30);
    });
  });

  describe('máximo de paradas', () => {
    it('reparte entre hojas cuando una sola pasaría del máximo', () => {
      const { orders, params } = escenario(
        Array.from({ length: 9 }, (_, i) => ({
          id: `p${i}`,
          at: { x: 2 + i * 0.5, y: 0 },
        })),
        { maxStopsPerSheet: 4 },
      );
      const plan = planFleet(
        orders,
        [vehiculo('v1'), vehiculo('v2'), vehiculo('v3')],
        params,
      );
      expect(plan.sheets.every((s) => s.orderIds.length <= 4)).toBe(true);
      expect(asignados(plan)).toHaveLength(9);
    });

    it('lo que no entra en ninguna por el máximo queda sin asignar por capacidad', () => {
      const { orders, params } = escenario(
        Array.from({ length: 5 }, (_, i) => ({
          id: `p${i}`,
          at: { x: 2 + i, y: 0 },
        })),
        { maxStopsPerSheet: 2 },
      );
      const plan = planFleet(orders, [vehiculo('v1'), vehiculo('v2')], params);
      expect(asignados(plan)).toHaveLength(4);
      expect(plan.unassigned.map((u) => u.reason)).toEqual(['capacity']);
    });
  });

  describe('lo que queda sin asignar, con el motivo', () => {
    it('sin punto de entrega', () => {
      const { orders, params } = escenario([
        { id: 'a', at: { x: 3, y: 0 } },
        { id: 'sin', at: null },
      ]);
      const plan = planFleet(orders, [vehiculo('v1')], params);
      expect(plan.unassigned).toEqual([{ orderId: 'sin', reason: 'no_point' }]);
      expect(asignados(plan)).toEqual(['a']);
    });

    it('sin vehículos', () => {
      const { orders, params } = escenario([
        { id: 'a', at: { x: 3, y: 0 } },
        { id: 'sin', at: null },
      ]);
      const plan = planFleet(orders, [], params);
      expect(plan.sheets).toEqual([]);
      expect(plan.unassigned).toEqual([
        { orderId: 'a', reason: 'no_vehicles' },
        { orderId: 'sin', reason: 'no_point' },
      ]);
    });

    it('una franja que no se alcanza ni saliendo directo del depósito', () => {
      const { orders, params } = escenario([
        { id: 'a', at: { x: 3, y: 0 } },
        { id: 'tarde', at: { x: 20, y: 0 }, window: [0, 10] }, // 40 min de viaje
      ]);
      const plan = planFleet(orders, [vehiculo('v1')], params);
      expect(plan.unassigned).toEqual([{ orderId: 'tarde', reason: 'window' }]);
      expect(asignados(plan)).toEqual(['a']);
    });

    it('una franja que sólo se rompe por el recorrido de ese vehículo pasa a otra hoja', () => {
      // Dos pedidos urgentes en el mismo rincón: juntos uno llega tarde; en hojas distintas, no.
      const { orders, params } = escenario([
        { id: 'u1', at: { x: 10, y: 0 }, window: [0, 22] },
        { id: 'u2', at: { x: 10, y: 0.1 }, window: [0, 22] },
      ]);
      const plan = planFleet(orders, [vehiculo('v1'), vehiculo('v2')], params);
      expect(plan.unassigned).toEqual([]);
      expect(plan.sheets).toHaveLength(2);
      expect(hojaDe(plan, 'u1')).not.toBe(hojaDe(plan, 'u2'));
    });

    it('si hay un solo vehículo, el urgente que no cabe junto al otro queda sin asignar por franja', () => {
      const { orders, params } = escenario([
        { id: 'u1', at: { x: 10, y: 0 }, window: [0, 22] },
        { id: 'u2', at: { x: 10, y: 0.1 }, window: [0, 22] },
      ]);
      const plan = planFleet(orders, [vehiculo('v1')], params);
      expect(plan.sheets[0].orderIds).toHaveLength(1);
      expect(plan.unassigned).toHaveLength(1);
      expect(plan.unassigned[0].reason).toBe('window');
    });
  });

  describe('relocate entre hojas', () => {
    function instancia(seed: number) {
      const azar = seeded(seed);
      return escenario(
        Array.from({ length: 20 }, (_, i) => ({
          id: `p${String(i).padStart(2, '0')}`,
          at: { x: (azar() - 0.5) * 30, y: (azar() - 0.5) * 30 },
          kg: 10 + Math.floor(azar() * 20),
          window: [
            Math.floor(azar() * 4) * 60,
            Math.floor(azar() * 4) * 60 + 240,
          ] as [number, number],
        })),
      );
    }
    const duracion = (p: FleetPlan) =>
      p.sheets.reduce((t, s) => t + (s.schedule.finishMs - T0) / MIN, 0);
    const flota = [
      vehiculo('v1', 200),
      vehiculo('v2', 200),
      vehiculo('v3', 200),
    ];

    it('baja el tiempo total respecto de dejar el barrido como quedó', () => {
      const { orders, params } = instancia(3);
      const con = planFleet(orders, flota, params);
      const sin = planFleet(orders, flota, { ...params, maxRelocations: 0 });
      expect(sin.relocations).toBe(0);
      expect(con.relocations).toBeGreaterThan(0);
      expect(duracion(con)).toBeLessThan(duracion(sin));
    });

    it('el tope de movimientos se respeta', () => {
      const { orders, params } = instancia(3);
      expect(
        planFleet(orders, flota, { ...params, maxRelocations: 1 }).relocations,
      ).toBe(1);
    });

    it.each([1, 2, 3, 4, 5, 6])(
      'caso %i: después de mover, las hojas siguen dentro de franja y de capacidad',
      (seed) => {
        const { orders, params } = instancia(seed);
        const plan = planFleet(orders, flota, params);
        for (const hoja of plan.sheets) {
          expect(hoja.schedule.lateCount).toBe(0);
          expect(hoja.peakKg).toBeLessThanOrEqual(200);
        }
        expect(
          [...asignados(plan), ...plan.unassigned.map((u) => u.orderId)].sort(),
        ).toEqual(orders.map((o) => o.id).sort());
      },
    );
  });

  it('es determinista: el orden en que llegan los pedidos y los vehículos no cambia el reparto', () => {
    const azar = seeded(21);
    const { orders, params } = escenario(
      Array.from({ length: 25 }, (_, i) => ({
        id: `p${String(i).padStart(2, '0')}`,
        at: { x: (azar() - 0.5) * 30, y: (azar() - 0.5) * 30 },
        kg: 10 + Math.floor(azar() * 10),
      })),
    );
    const flota = [
      vehiculo('v1', 120),
      vehiculo('v2', 120),
      vehiculo('v3', 120),
    ];
    const base = planFleet(orders, flota, params);
    const baraja = seeded(5);
    const mezclados = [...orders].sort(() => baraja() - 0.5);
    const flotaMezclada = [...flota].sort(() => baraja() - 0.5);
    const otro = planFleet(mezclados, flotaMezclada, params);
    expect(otro.sheets.map((s) => [s.vehicleId, s.orderIds])).toEqual(
      base.sheets.map((s) => [s.vehicleId, s.orderIds]),
    );
    expect(otro.unassigned).toEqual(base.unassigned);
  });

  it('150 pedidos entre 10 vehículos se resuelven en menos de 2 segundos', () => {
    const azar = seeded(99);
    const { orders, params } = escenario(
      Array.from({ length: 150 }, (_, i) => {
        const ini = Math.floor(azar() * 4) * 60;
        return {
          id: `p${String(i).padStart(3, '0')}`,
          at: { x: (azar() - 0.5) * 30, y: (azar() - 0.5) * 30 },
          kg: 10 * (1 + Math.floor(azar() * 3)),
          units: 1 + Math.floor(azar() * 3),
          window: [ini, ini + 240] as [number, number],
        };
      }),
    );
    const flota = Array.from({ length: 10 }, (_, i) =>
      vehiculo(`v${i}`, 400, 40),
    );
    const t0 = Date.now();
    const plan = planFleet(orders, flota, params);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(asignados(plan).length + plan.unassigned.length).toBe(150);
    expect(plan.sheets.every((s) => s.schedule.lateCount === 0)).toBe(true);
  });

  it('con vehículos de distinta capacidad el reparto tampoco depende del orden de la flota', () => {
    const azar = seeded(21);
    const { orders, params } = escenario(
      Array.from({ length: 25 }, (_, i) => ({
        id: `p${String(i).padStart(2, '0')}`,
        at: { x: (azar() - 0.5) * 30, y: (azar() - 0.5) * 30 },
        kg: 10 + Math.floor(azar() * 10),
      })),
    );
    const a = planFleet(
      orders,
      [vehiculo('grande', 300), vehiculo('chico', 60)],
      params,
    );
    const b = planFleet(
      orders,
      [vehiculo('chico', 60), vehiculo('grande', 300)],
      params,
    );
    expect(b.sheets.map((s) => [s.vehicleId, s.orderIds])).toEqual(
      a.sheets.map((s) => [s.vehicleId, s.orderIds]),
    );
    expect(b.unassigned).toEqual(a.unassigned);
  });

  it('con un solo vehículo y sin capacidad no deja sin asignar un día que alguna secuencia cumple', () => {
    const azar = seeded(7);
    let factibles = 0;
    for (let it = 0; it < 150; it++) {
      const n = 5;
      const pedidos: PedidoSpec[] = Array.from({ length: n }, (_, i) => {
        const desde = Math.floor(azar() * 120);
        return {
          id: `s${i}`,
          at: { x: azar() * 20 - 10, y: azar() * 20 - 10 },
          window: [desde, desde + 30 + Math.floor(azar() * 60)] as [
            number,
            number,
          ],
        };
      });
      const { orders, params } = escenario(pedidos);
      const rotulos = orders.map((o) => ({
        id: o.id,
        point: o.point as number,
        windowStartMs: o.windowStartMs,
        windowEndMs: o.windowEndMs,
      }));
      const factible = permutations(rotulos).some(
        (o) => computeSchedule(o, params.schedule).lateCount === 0,
      );
      if (!factible) continue;
      factibles++;
      const plan = planFleet(
        orders,
        [{ id: 'v1', capacityKg: null, capacityUnits: null }],
        {
          ...params,
          maxStopsPerSheet: 40,
        },
      );
      expect(plan.unassigned).toEqual([]);
    }
    expect(factibles).toBeGreaterThan(30);
  });

  describe('entradas inválidas', () => {
    it('ids de pedido repetidos se rechazan', () => {
      const { orders, params } = escenario([
        { id: 'a', at: { x: 1, y: 1 } },
        { id: 'a', at: { x: 2, y: 2 } },
      ]);
      expect(() => planFleet(orders, [vehiculo('v1', null)], params)).toThrow(
        InvalidRouteInputError,
      );
    });

    it('una coordenada NaN se rechaza con un error de dominio', () => {
      const { orders, params } = escenario([{ id: 'a', at: { x: 1, y: 1 } }]);
      expect(() =>
        planFleet([{ ...orders[0], lat: NaN }], [vehiculo('v1', null)], params),
      ).toThrow(InvalidRouteInputError);
    });

    it('vehículos con el mismo id se rechazan', () => {
      const { orders, params } = escenario([{ id: 'a', at: { x: 1, y: 1 } }]);
      expect(() =>
        planFleet(orders, [vehiculo('v1', null), vehiculo('v1', null)], params),
      ).toThrow(InvalidRouteInputError);
    });
  });

  describe('el motivo de lo que queda sin asignar', () => {
    it('por capacidad: en franja entraría, pero el pico de garrafas con los retiros no lo permite', () => {
      // Cada pedido entrega 1 y retira 2: con tope de 3 garrafas a bordo sólo cabe uno.
      const retiro: StopLoad = {
        ...SIN_CARGA,
        deliverUnits: 1,
        deliverKg: 10,
        pickupUnits: 2,
        pickupKg: 20,
      };
      const { orders, params } = escenario(
        ['a', 'b', 'c'].map((id, i) => ({
          id,
          at: { x: i + 1, y: 0 },
          load: retiro,
        })),
      );
      const plan = planFleet(orders, [vehiculo('v1', null, 3)], params);
      expect(plan.sheets).toHaveLength(1);
      expect(plan.sheets[0].orderIds).toHaveLength(1);
      expect(plan.unassigned).toHaveLength(2);
      expect(plan.unassigned.map((u) => u.reason)).toEqual([
        'capacity',
        'capacity',
      ]);
    });

    it('por franja: no llega ni saliendo directo desde el depósito', () => {
      const { orders, params } = escenario([
        { id: 'a', at: { x: 1, y: 0 } },
        { id: 'lejos', at: { x: 90, y: 0 }, window: [0, 5] },
      ]);
      const plan = planFleet(orders, [vehiculo('v1')], params);
      expect(plan.unassigned).toEqual([{ orderId: 'lejos', reason: 'window' }]);
    });

    it('sin probar: si la búsqueda de factibilidad se corta, no se afirma que no entra', () => {
      // El mismo caso de 9 paradas del optimizador, con la búsqueda de factibilidad sin presupuesto.
      const pts: Array<[number, number]> = [
        [-7.72, -1.53],
        [-7.83, -6.27],
        [-1.04, 0.74],
        [-2.48, -8.06],
        [-1.59, 4.38],
        [-5.93, 3.26],
        [-5.81, 7.56],
        [4.63, 2.98],
        [2.73, -4.56],
      ];
      const franjas: Array<[number, number]> = [
        [70, 150],
        [155, 209],
        [88, 132],
        [130, 201],
        [23, 71],
        [94, 134],
        [55, 152],
        [139, 212],
        [165, 261],
      ];
      const { orders, params } = escenario(
        pts.map(([x, y], i) => ({
          id: `s${i}`,
          at: { x, y },
          window: franjas[i],
        })),
        { maxSearchNodes: 1 },
      );
      const plan = planFleet(orders, [vehiculo('v1')], params);
      expect(plan.unassigned).toEqual([
        { orderId: 's1', reason: 'window_unverified' },
      ]);
      // Con el presupuesto por omisión entran las nueve.
      const completo = planFleet(orders, [vehiculo('v1')], {
        ...params,
        maxSearchNodes: undefined,
      });
      expect(completo.unassigned).toEqual([]);
      expect(asignados(completo)).toHaveLength(9);
    });
  });

  it('dos pedidos sin punto de entrega con el mismo id también se rechazan', () => {
    const { orders, params } = escenario([
      { id: 'a', at: null },
      { id: 'a', at: null },
    ]);
    expect(() => planFleet(orders, [vehiculo('v1')], params)).toThrow(
      InvalidRouteInputError,
    );
  });

  it('una latitud o longitud fuera de rango se rechaza aunque el punto exista', () => {
    const { orders, params } = escenario([{ id: 'a', at: { x: 1, y: 1 } }]);
    expect(() =>
      planFleet([{ ...orders[0], lat: 91 }], [vehiculo('v1')], params),
    ).toThrow(InvalidRouteInputError);
    expect(() =>
      planFleet([{ ...orders[0], lng: null }], [vehiculo('v1')], params),
    ).toThrow(InvalidRouteInputError);
  });

  it('150 pedidos con franjas angostas entre 10 vehículos: sin exclusiones falsas y en menos de 2 segundos', () => {
    const azar = seeded(77);
    const { orders, params } = escenario(
      Array.from({ length: 150 }, (_, i) => {
        const ini = Math.floor(azar() * 8) * 30;
        return {
          id: `p${String(i).padStart(3, '0')}`,
          at: { x: (azar() - 0.5) * 30, y: (azar() - 0.5) * 30 },
          kg: 10,
          window: [ini, ini + 60] as [number, number],
        };
      }),
    );
    const flota = Array.from({ length: 10 }, (_, i) =>
      vehiculo(`v${i}`, 400, 40),
    );
    const t0 = Date.now();
    const plan = planFleet(orders, flota, params);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(asignados(plan).length + plan.unassigned.length).toBe(150);
    expect(plan.sheets.every((s) => s.schedule.lateCount === 0)).toBe(true);
    // Lo que no se asignó tiene un motivo: nunca se pierde un pedido sin decirlo.
    for (const u of plan.unassigned) expect(u.reason).toBeDefined();
  });
});
