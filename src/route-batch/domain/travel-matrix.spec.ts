import { matrixOf } from './route-fixtures';
import { applyTrafficFactor } from './travel-matrix';

describe('applyTrafficFactor', () => {
  const base = matrixOf([
    { x: 0, y: 0 },
    { x: 15, y: 0 },
  ]); // 15 km a 30 km/h = 30 min

  it('multiplica los tiempos de OSRM, que son a flujo libre, y deja los kilómetros', () => {
    const m = applyTrafficFactor(base, 1.2, 'osrm');
    expect(m.minutes[0][1]).toBeCloseTo(36);
    expect(m.km[0][1]).toBe(15);
    expect(m.minutes[0][0]).toBe(0);
  });

  it('no vuelve a inflar los tiempos de línea recta, que ya traen la velocidad urbana', () => {
    expect(applyTrafficFactor(base, 1.2, 'haversine')).toBe(base);
  });

  it('con factor 1 devuelve la misma matriz', () => {
    expect(applyTrafficFactor(base, 1, 'osrm')).toBe(base);
  });

  it('no modifica la matriz original', () => {
    applyTrafficFactor(base, 2, 'osrm');
    expect(base.minutes[0][1]).toBeCloseTo(30);
  });
});
