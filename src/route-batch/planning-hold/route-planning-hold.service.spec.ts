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
    // También lo que salió de una hoja en la calle y espera al admin.
    expect(sql).toContain(`'needs_reschedule'`);
    expect(sql).toContain('sa."removed_at" >= ba."started_at"');
    // Lo que la hoja reprogramó solo para otro día (segundo intento, cierre a
    // mano) sigue retenido del arranque de pendientes aunque cambió la fecha.
    expect(sql).toContain(
      `sa."removed_reason"::text IN ('needs_reschedule', 'rescheduled', 'sheet_closed')`,
    );
    // Un programado sin franja fija (reprogramado por la hoja) también se retiene.
    expect(sql).not.toContain('"time_slot_id" IS NOT NULL');
  });
});
