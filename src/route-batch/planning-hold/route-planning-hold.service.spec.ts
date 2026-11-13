import { DataSource } from 'typeorm';
import { RoutePlanningHoldService } from './route-planning-hold.service';

describe('RoutePlanningHoldService.isHeldForPlanning', () => {
  const armar = (filas: Array<{ orderId: string }>) => {
    const ds = { query: jest.fn().mockResolvedValue(filas) };
    return {
      ds,
      svc: new RoutePlanningHoldService(ds as unknown as DataSource),
    };
  };

  it('sin pedidos no consulta', async () => {
    const { ds, svc } = armar([]);
    expect(await svc.isHeldForPlanning([])).toEqual(new Set());
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('devuelve los retenidos: parada viva de una hoja en borrador o confirmada, o programado de un día sin cerrar', async () => {
    const { ds, svc } = armar([{ orderId: 'o2' }]);
    expect(await svc.isHeldForPlanning(['o1', 'o2'])).toEqual(new Set(['o2']));
    const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([['o1', 'o2']]);
    expect(sql).toContain(
      `b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed')`,
    );
    expect(sql).toContain(`mc."module"::text = 'route_planning'`);
    expect(sql).toContain(`p."status" = 'closed'`);
  });
});
