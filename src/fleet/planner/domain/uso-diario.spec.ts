import {
  FACTOR_DE_RECORRIDO,
  calibrarConOdometro,
  distanciaKm,
  usoDelDia,
  type LecturaDeOdometro,
  type ParadaEntregada,
} from './uso-diario';

// Corrientes, Argentina: ~0,009° de latitud son ~1 km.
const parada = (hora: string, lat: number, lng = -58.83): ParadaEntregada => ({
  at: new Date(`2026-10-20T${hora}:00Z`),
  lat,
  lng,
});

describe('distanciaKm', () => {
  it('un grado de latitud son unos 111 km', () => {
    expect(
      distanciaKm({ lat: -27, lng: -58 }, { lat: -28, lng: -58 }),
    ).toBeCloseTo(111.2, 0);
  });

  it('un punto consigo mismo es 0', () => {
    expect(distanciaKm({ lat: -27, lng: -58 }, { lat: -27, lng: -58 })).toBe(0);
  });
});

describe('usoDelDia', () => {
  it('suma los tramos entre paradas en el orden en que se entregaron, por el factor de calles', () => {
    const uso = usoDelDia('2026-10-20', [
      parada('15:00', -27.46),
      parada('13:00', -27.45),
      parada('14:00', -27.44),
    ]);
    // Ordenadas: -27.45 -> -27.44 -> -27.46 = 0,01° + 0,02° de latitud ≈ 3,34 km.
    expect(uso.km).toBeCloseTo(3.34 * FACTOR_DE_RECORRIDO, 1);
    expect(uso.orders).toBe(3);
    expect(uso.routeHours).toBe(2);
  });

  it('una sola parada no tiene tramo', () => {
    const uso = usoDelDia('2026-10-20', [parada('13:00', -27.45)]);
    expect(uso).toMatchObject({ km: 0, orders: 1, routeHours: 0 });
  });

  it('un día sin paradas vale cero', () => {
    expect(usoDelDia('2026-10-20', [])).toMatchObject({ km: 0, orders: 0 });
  });
});

describe('calibrarConOdometro', () => {
  const est = (day: string, km: number) => ({
    day,
    km,
    orders: 1,
    routeHours: 1,
  });
  const lectura = (iso: string, km: number): LecturaDeOdometro => ({
    at: new Date(iso),
    km,
  });

  it('sin lecturas deja lo estimado por recorrido', () => {
    const r = calibrarConOdometro([est('2026-10-20', 12)], []);
    expect(r).toEqual([est('2026-10-20', 12)]);
  });

  it('el odómetro manda: reparte lo recorrido entre sus días en proporción a lo estimado', () => {
    const r = calibrarConOdometro(
      [est('2026-10-21', 10), est('2026-10-22', 30)],
      [
        lectura('2026-10-20T15:00:00Z', 1000),
        lectura('2026-10-22T15:00:00Z', 1100),
      ],
    );
    expect(r.find((u) => u.day === '2026-10-21')?.km).toBeCloseTo(25, 5);
    expect(r.find((u) => u.day === '2026-10-22')?.km).toBeCloseTo(75, 5);
    expect(r.reduce((a, u) => a + u.km, 0)).toBeCloseTo(100, 5);
  });

  it('sin estimación en el tramo reparte en partes iguales, también en días sin entregas', () => {
    const r = calibrarConOdometro(
      [],
      [
        lectura('2026-10-20T15:00:00Z', 1000),
        lectura('2026-10-23T15:00:00Z', 1090),
      ],
    );
    expect(r.map((u) => u.km)).toEqual([30, 30, 30]);
    expect(r.map((u) => u.day)).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ]);
  });

  it('los días fuera de todo tramo conservan el recorrido estimado', () => {
    const r = calibrarConOdometro(
      [est('2026-10-10', 7), est('2026-10-21', 10)],
      [
        lectura('2026-10-20T15:00:00Z', 1000),
        lectura('2026-10-21T15:00:00Z', 1040),
      ],
    );
    expect(r.find((u) => u.day === '2026-10-10')?.km).toBe(7);
    expect(r.find((u) => u.day === '2026-10-21')?.km).toBe(40);
  });

  it('ignora una lectura que no sube (error de carga)', () => {
    const r = calibrarConOdometro(
      [est('2026-10-22', 5)],
      [
        lectura('2026-10-20T15:00:00Z', 1000),
        lectura('2026-10-21T15:00:00Z', 900),
        lectura('2026-10-22T15:00:00Z', 1050),
      ],
    );
    expect(r.reduce((a, u) => a + u.km, 0)).toBeCloseTo(50, 5);
  });

  it('dos lecturas el mismo día calibran ese día', () => {
    const r = calibrarConOdometro(
      [est('2026-10-20', 3)],
      [
        lectura('2026-10-20T11:00:00Z', 1000),
        lectura('2026-10-20T20:00:00Z', 1015),
      ],
    );
    expect(r.find((u) => u.day === '2026-10-20')?.km).toBe(15);
  });
});
