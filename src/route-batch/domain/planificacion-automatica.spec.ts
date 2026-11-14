import {
  DistribuidoraParaPlanificar,
  PedidoParaRetener,
  planificacionAutomatica,
  retenidoPorLaPlanificacion,
} from './planificacion-automatica';

const HOY = '2026-11-13';
const MANANA = '2026-11-14';
// Cierre de mañana por omisión: 13/11 a las 18:00 de Argentina (21:00 UTC).
const ANTES_DEL_CIERRE = new Date('2026-11-13T15:00:00Z');
const DESPUES_DEL_CIERRE = new Date('2026-11-13T21:30:00Z');

const dist = (
  over: Partial<DistribuidoraParaPlanificar> = {},
): DistribuidoraParaPlanificar => ({
  status: 'active',
  deletedAt: null,
  params: null,
  ...over,
});

const pedido = (over: Partial<PedidoParaRetener> = {}): PedidoParaRetener => ({
  scheduledDate: MANANA,
  deliveryMode: 'standard',
  createdAt: ANTES_DEL_CIERRE,
  distribuidora: dist(),
  plan: null,
  ...over,
});

describe('planificacionAutomatica', () => {
  it('sin parámetros guardados planifica sola (enabled y autoPropose por omisión)', () => {
    expect(planificacionAutomatica(dist())).toMatchObject({
      enabled: 1,
      autoPropose: 1,
      cutoffHour: 18,
    });
    expect(
      planificacionAutomatica(dist({ params: { cutoffHour: 20 } })),
    ).toMatchObject({ enabled: 1, cutoffHour: 20 });
  });

  it('enabled 0 o autoPropose 0 guardados: no', () => {
    expect(planificacionAutomatica(dist({ params: { enabled: 0 } }))).toBe(
      null,
    );
    expect(planificacionAutomatica(dist({ params: { autoPropose: 0 } }))).toBe(
      null,
    );
  });

  it('suspendida o dada de baja: no', () => {
    expect(planificacionAutomatica(dist({ status: 'suspended' }))).toBe(null);
    expect(planificacionAutomatica(dist({ deletedAt: new Date() }))).toBe(null);
  });
});

describe('retenidoPorLaPlanificacion', () => {
  it('programado para mañana, creado antes del cierre, sin parámetros guardados: se retiene', () => {
    expect(retenidoPorLaPlanificacion(pedido(), HOY)).toBe(true);
    // Con el día abierto o propuesto (antes de su cierre) también.
    expect(
      retenidoPorLaPlanificacion(
        pedido({
          plan: {
            status: 'proposed',
            cutoffAt: new Date('2026-11-13T21:00:00Z'),
          },
        }),
        HOY,
      ),
    ).toBe(true);
  });

  it('con enabled 0 o autoPropose 0 guardados no se retiene (nadie lo va a proponer)', () => {
    for (const params of [{ enabled: 0 }, { autoPropose: 0 }]) {
      expect(
        retenidoPorLaPlanificacion(
          pedido({ distribuidora: dist({ params }) }),
          HOY,
        ),
      ).toBe(false);
    }
  });

  it('distribuidora suspendida o dada de baja: no se retiene', () => {
    expect(
      retenidoPorLaPlanificacion(
        pedido({ distribuidora: dist({ status: 'suspended' }) }),
        HOY,
      ),
    ).toBe(false);
    expect(
      retenidoPorLaPlanificacion(
        pedido({ distribuidora: dist({ deletedAt: '2026-11-01' }) }),
        HOY,
      ),
    ).toBe(false);
  });

  it('el día del reparto (o uno pasado) ya no se retiene: vuelve al despacho común', () => {
    expect(
      retenidoPorLaPlanificacion(pedido({ scheduledDate: HOY }), HOY),
    ).toBe(false);
    expect(
      retenidoPorLaPlanificacion(pedido({ scheduledDate: '2026-11-12' }), HOY),
    ).toBe(false);
  });

  it('con el día cerrado, o creado después de su cierre, no se retiene', () => {
    expect(
      retenidoPorLaPlanificacion(
        pedido({
          plan: {
            status: 'closed',
            cutoffAt: new Date('2026-11-13T21:00:00Z'),
          },
        }),
        HOY,
      ),
    ).toBe(false);
    expect(
      retenidoPorLaPlanificacion(
        pedido({ createdAt: DESPUES_DEL_CIERRE }),
        HOY,
      ),
    ).toBe(false);
    // El cierre del plan ya abierto manda (se abrió con otro horario).
    expect(
      retenidoPorLaPlanificacion(
        pedido({
          plan: {
            status: 'open',
            cutoffAt: new Date('2026-11-13T14:00:00Z'),
          },
        }),
        HOY,
      ),
    ).toBe(false);
  });

  it('el cierre sale de los parámetros guardados', () => {
    // Cierre 12:00 (15:00 UTC): creado justo a esa hora ya no entra.
    expect(
      retenidoPorLaPlanificacion(
        pedido({ distribuidora: dist({ params: { cutoffHour: 12 } }) }),
        HOY,
      ),
    ).toBe(false);
  });

  it('sin fecha o express: no', () => {
    expect(
      retenidoPorLaPlanificacion(pedido({ scheduledDate: null }), HOY),
    ).toBe(false);
    expect(
      retenidoPorLaPlanificacion(pedido({ deliveryMode: 'express' }), HOY),
    ).toBe(false);
  });
});
