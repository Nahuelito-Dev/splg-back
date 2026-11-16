import { DataSource } from 'typeorm';
import { RoutePlanningHoldService } from './route-planning-hold.service';

describe('RoutePlanningHoldService.isHeldForPlanning', () => {
  const armar = (filas: Array<Record<string, unknown>>) => {
    const ds = { query: jest.fn().mockResolvedValue(filas) };
    return {
      ds,
      svc: new RoutePlanningHoldService(ds as unknown as DataSource),
    };
  };

  // Un programado para dentro de 10 días, creado ahora (antes de su cierre).
  const enDiezDias = new Date(Date.now() + 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const fila = (over: Record<string, unknown> = {}) => ({
    orderId: 'o1',
    enHoja: false,
    scheduledDate: enDiezDias,
    deliveryMode: 'standard',
    createdAt: new Date(),
    distributorStatus: 'active',
    distributorDeletedAt: null,
    params: null,
    planStatus: null,
    planCutoffAt: null,
    ...over,
  });

  it('sin pedidos no consulta', async () => {
    const { ds, svc } = armar([]);
    expect(await svc.isHeldForPlanning([])).toEqual(new Set());
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('parada viva de una hoja o esperando al admin: retenido, aunque la planificación no lo tome', async () => {
    const { ds, svc } = armar([
      fila({
        orderId: 'o1',
        enHoja: true,
        scheduledDate: null,
        params: { enabled: 0 },
      }),
      fila({ orderId: 'o2', scheduledDate: null }),
    ]);
    expect(await svc.isHeldForPlanning(['o1', 'o2'])).toEqual(new Set(['o1']));
    const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([['o1', 'o2']]);
    expect(sql).toContain(
      `b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed')`,
    );
    // También lo que salió de una hoja en la calle y espera al admin.
    expect(sql).toContain(`'needs_reschedule'`);
    expect(sql).toContain('sa."removed_at" >= ba."started_at"');
    expect(sql).toContain(
      `sa."removed_reason"::text IN ('needs_reschedule', 'rescheduled', 'sheet_closed')`,
    );
  });

  it('programado: decide el mismo predicado que la propuesta (sin fila retiene; enabled 0, autoPropose 0 o suspendida no)', async () => {
    const { svc } = armar([
      fila({ orderId: 'sin-fila' }),
      fila({ orderId: 'apagada', params: { enabled: 0 } }),
      fila({ orderId: 'a-mano', params: { autoPropose: 0 } }),
      fila({ orderId: 'suspendida', distributorStatus: 'suspended' }),
      fila({ orderId: 'baja', distributorDeletedAt: new Date() }),
      fila({
        orderId: 'cerrado',
        planStatus: 'closed',
        planCutoffAt: new Date(Date.now() + 86_400_000),
      }),
    ]);
    expect(
      await svc.isHeldForPlanning([
        'sin-fila',
        'apagada',
        'a-mano',
        'suspendida',
        'baja',
        'cerrado',
      ]),
    ).toEqual(new Set(['sin-fila']));
  });

  it('el día del reparto ya no se retiene: vuelve al despacho común', async () => {
    const hoy = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
    }).format(new Date());
    const { svc } = armar([fila({ scheduledDate: hoy })]);
    expect(await svc.isHeldForPlanning(['o1'])).toEqual(new Set());
  });

  it('un programado sin franja fija también se retiene (la consulta no exige franja)', async () => {
    const { ds, svc } = armar([fila()]);
    expect(await svc.isHeldForPlanning(['o1'])).toEqual(new Set(['o1']));
    const [sql] = ds.query.mock.calls[0] as [string];
    expect(sql).not.toContain('"time_slot_id" IS NOT NULL');
    // La fila de parámetros es opcional: una distribuidora sin configurar también entra.
    expect(sql).toContain('LEFT JOIN "module_config" mc');
  });
});
