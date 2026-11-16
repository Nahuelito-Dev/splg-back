/**
 * Tiempo de `planFleet` con 150 pedidos. Corre aparte y en serie (`npm run test:perf`, parte de
 * `npm run verify`) para que la carga de otros tests en paralelo no falsee la medición.
 */
import { planFleet } from './fleet-assignment';
import { asignados, escenario, vehiculo } from './fleet-fixtures';
import { seeded } from './route-fixtures';

const flota = () =>
  Array.from({ length: 10 }, (_, i) => vehiculo(`v${i}`, 400, 40));

describe('planFleet: tiempo', () => {
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
    const t0 = Date.now();
    const plan = planFleet(orders, flota(), params);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(asignados(plan).length + plan.unassigned.length).toBe(150);
  });

  it('150 pedidos con franjas angostas entre 10 vehículos se resuelven en menos de 2 segundos', () => {
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
    const t0 = Date.now();
    const plan = planFleet(orders, flota(), params);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(asignados(plan).length + plan.unassigned.length).toBe(150);
  });
});
