import {
  DeliveryKind,
  FranjaDelDia,
  MAX_VISITAS_FALLIDAS,
  RevisitStatus,
  decideElAdmin,
  diasCandidatos,
  elegirFranja,
  proponerNuevaVisita,
  puedeFijarElAdmin,
  puedeResponderElCliente,
} from './nueva-visita';

const sumar = (fecha: string, dias: number): string => {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
/** Lunes a sábado, con el martes 24/11 feriado. */
const habil = (fecha: string): boolean =>
  new Date(`${fecha}T12:00:00Z`).getUTCDay() !== 0 && fecha !== '2026-11-24';

const franja = (id: string, remaining: number): FranjaDelDia => ({
  timeSlotId: id,
  name: id,
  startTime: id === 'manana' ? '09:00:00' : '14:00:00',
  endTime: id === 'manana' ? '13:00:00' : '18:00:00',
  remaining,
});

describe('Nueva visita: tope de visitas fallidas', () => {
  it('N = 2: a la primera reprograma el sistema; a la segunda decide el admin', () => {
    expect(MAX_VISITAS_FALLIDAS).toBe(2);
    expect(decideElAdmin(1)).toBe(false);
    expect(decideElAdmin(2)).toBe(true);
    expect(decideElAdmin(3)).toBe(true);
  });
});

describe('Nueva visita: franja del día', () => {
  it('la franja del pedido original si tiene cupo', () => {
    expect(
      elegirFranja([franja('manana', 3), franja('tarde', 1)], 'tarde')
        ?.timeSlotId,
    ).toBe('tarde');
  });

  it('si la original está completa (o ya terminó), la primera con cupo', () => {
    expect(
      elegirFranja([franja('manana', 2), franja('tarde', 0)], 'tarde')
        ?.timeSlotId,
    ).toBe('manana');
  });

  it('sin franja original, la primera con cupo; sin cupo en ninguna, null', () => {
    expect(
      elegirFranja([franja('manana', 0), franja('tarde', 4)], null)?.timeSlotId,
    ).toBe('tarde');
    expect(elegirFranja([franja('manana', 0), franja('tarde', 0)], null)).toBe(
      null,
    );
  });
});

describe('Nueva visita: días candidatos según el tipo de entrega', () => {
  // Sábado 21/11/2026.
  const hoy = '2026-11-21';

  it('pedido suelto: desde el próximo día hábil (saltea el domingo y el feriado), nunca hoy', () => {
    const dias = diasCandidatos(DeliveryKind.SINGLE, hoy, habil, sumar, 5);
    expect(dias).toEqual(['2026-11-23', '2026-11-25', '2026-11-26']);
  });

  it('express: primero hoy (lo antes posible) y después los días hábiles', () => {
    const dias = diasCandidatos(DeliveryKind.EXPRESS, hoy, habil, sumar, 3);
    expect(dias).toEqual(['2026-11-21', '2026-11-23']);
  });

  it('express: hoy sólo si es hábil (un feriado o un domingo no se propone)', () => {
    // Martes 24/11 feriado y domingo 22/11: arranca por el día hábil siguiente.
    expect(
      diasCandidatos(DeliveryKind.EXPRESS, '2026-11-24', habil, sumar, 2),
    ).toEqual(['2026-11-25', '2026-11-26']);
    expect(
      diasCandidatos(DeliveryKind.EXPRESS, '2026-11-22', habil, sumar, 1),
    ).toEqual(['2026-11-23']);
  });
});

describe('Nueva visita: propuesta respetando el cupo', () => {
  const dias = ['2026-11-23', '2026-11-25'];

  it('pedido suelto: el primer día con la franja original libre', async () => {
    const p = await proponerNuevaVisita(
      DeliveryKind.SINGLE,
      dias,
      'tarde',
      () => Promise.resolve([franja('manana', 5), franja('tarde', 2)]),
    );
    expect(p).toEqual({ date: '2026-11-23', timeSlotId: 'tarde' });
  });

  it('pedido suelto: con la original completa, la primera libre del mismo día', async () => {
    const p = await proponerNuevaVisita(
      DeliveryKind.SINGLE,
      dias,
      'tarde',
      () => Promise.resolve([franja('manana', 5), franja('tarde', 0)]),
    );
    expect(p).toEqual({ date: '2026-11-23', timeSlotId: 'manana' });
  });

  it('un día sin cupo en ninguna franja se saltea', async () => {
    const p = await proponerNuevaVisita(
      DeliveryKind.SINGLE,
      dias,
      'tarde',
      (fecha) =>
        Promise.resolve(
          fecha === '2026-11-23'
            ? [franja('manana', 0), franja('tarde', 0)]
            : [franja('manana', 0), franja('tarde', 7)],
        ),
    );
    expect(p).toEqual({ date: '2026-11-25', timeSlotId: 'tarde' });
  });

  it('express: la próxima franja libre de hoy, aunque no sea la original', async () => {
    const p = await proponerNuevaVisita(
      DeliveryKind.EXPRESS,
      ['2026-11-21', '2026-11-23'],
      'tarde',
      () => Promise.resolve([franja('manana', 1), franja('tarde', 9)]),
    );
    expect(p).toEqual({ date: '2026-11-21', timeSlotId: 'manana' });
  });

  it('express: si hoy ya no queda franja, mañana a primera hora', async () => {
    const p = await proponerNuevaVisita(
      DeliveryKind.EXPRESS,
      ['2026-11-21', '2026-11-23'],
      null,
      (fecha) =>
        Promise.resolve(
          fecha === '2026-11-21'
            ? [franja('manana', 0), franja('tarde', 0)]
            : [franja('manana', 4), franja('tarde', 4)],
        ),
    );
    expect(p).toEqual({ date: '2026-11-23', timeSlotId: 'manana' });
  });

  it('sin lugar en todo el horizonte no propone nada (decide el admin)', async () => {
    const p = await proponerNuevaVisita(DeliveryKind.SINGLE, dias, null, () =>
      Promise.resolve([franja('manana', 0)]),
    );
    expect(p).toBeNull();
  });

  it('una distribuidora sin franjas: el primer día candidato, sin franja', async () => {
    const p = await proponerNuevaVisita(DeliveryKind.SINGLE, dias, null, () =>
      Promise.resolve([]),
    );
    expect(p).toEqual({ date: '2026-11-23', timeSlotId: null });
  });
});

describe('Nueva visita: quién puede cambiarla', () => {
  const base = {
    status: 'pending',
    deliveryId: null,
    revisitStatus: RevisitStatus.PROPOSED as string | null,
  };

  it('el cliente contesta sólo una propuesta de un pedido pendiente sin chofer', () => {
    expect(puedeResponderElCliente(base)).toBe(true);
    expect(
      puedeResponderElCliente({
        ...base,
        revisitStatus: RevisitStatus.CONFIRMED,
      }),
    ).toBe(false);
    expect(
      puedeResponderElCliente({
        ...base,
        revisitStatus: RevisitStatus.AWAITING_ADMIN,
      }),
    ).toBe(false);
    expect(puedeResponderElCliente({ ...base, deliveryId: 'd1' })).toBe(false);
    expect(puedeResponderElCliente({ ...base, status: 'cancelled' })).toBe(
      false,
    );
    expect(puedeResponderElCliente({ ...base, revisitStatus: null })).toBe(
      false,
    );
  });

  it('el admin fija en cualquier estado de la nueva visita, mientras el pedido siga pendiente sin chofer', () => {
    for (const estado of Object.values(RevisitStatus)) {
      expect(puedeFijarElAdmin({ ...base, revisitStatus: estado })).toBe(true);
    }
    expect(puedeFijarElAdmin({ ...base, revisitStatus: null })).toBe(false);
    expect(puedeFijarElAdmin({ ...base, status: 'delivered' })).toBe(false);
    expect(puedeFijarElAdmin({ ...base, deliveryId: 'd1' })).toBe(false);
  });
});
