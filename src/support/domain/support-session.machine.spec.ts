import {
  SupportEndReason,
  SupportScope,
  SupportSessionKind,
  SupportSessionStatus as S,
} from './support-session.enums';
import {
  AprobacionExcedeLoPedidoError,
  DuracionInvalidaError,
  SesionNoPendienteError,
  SesionYaTerminadaError,
  SolicitudCaducadaError,
} from './support-session.errors';
import {
  AccionDeSoporte as A,
  assertAprobable,
  esFinal,
  finDeLaSesion,
  motivoDeFin,
  resolverAprobacion,
  siguienteEstado,
  solicitudCaducada,
  validarDuracion,
} from './support-session.machine';

/** La tabla completa: estado × acción → destino, o el error que corresponde. */
const ESPERADO: Record<S, Partial<Record<A, S>>> = {
  [S.PENDING]: {
    [A.APROBAR]: S.ACTIVE,
    [A.RECHAZAR]: S.REJECTED,
    [A.RETIRAR]: S.CANCELLED,
    [A.CADUCAR]: S.EXPIRED_REQUEST,
  },
  [S.ACTIVE]: {
    [A.SALIR]: S.ENDED,
    [A.REVOCAR]: S.REVOKED,
    [A.VENCER]: S.EXPIRED,
  },
  [S.REJECTED]: {},
  [S.EXPIRED_REQUEST]: {},
  [S.CANCELLED]: {},
  [S.ENDED]: {},
  [S.REVOKED]: {},
  [S.EXPIRED]: {},
};

const DE_SOLICITUD = new Set([A.APROBAR, A.RECHAZAR, A.RETIRAR, A.CADUCAR]);

describe('máquina de estados de la sesión de soporte', () => {
  const casos = Object.values(S).flatMap((estado) =>
    Object.values(A).map((accion) => [estado, accion] as const),
  );

  /** El destino, o el nombre del error que lanzó. */
  function resultado(estado: S, accion: A): string {
    try {
      return siguienteEstado(estado, accion);
    } catch (error) {
      return (error as Error).constructor.name;
    }
  }

  it.each(casos)('%s + %s', (estado, accion) => {
    const esperado =
      ESPERADO[estado][accion] ??
      (DE_SOLICITUD.has(accion)
        ? SesionNoPendienteError.name
        : SesionYaTerminadaError.name);
    expect(resultado(estado, accion)).toBe(esperado);
  });

  it('los errores llevan el code que reconoce el panel', () => {
    expect(new SesionNoPendienteError().code).toBe(
      'SUPPORT_SESSION_NOT_PENDING',
    );
    expect(new SesionYaTerminadaError().code).toBe(
      'SUPPORT_SESSION_ALREADY_ENDED',
    );
    expect(new SolicitudCaducadaError().code).toBe('SUPPORT_REQUEST_EXPIRED');
    expect(new AprobacionExcedeLoPedidoError('x').code).toBe(
      'SUPPORT_APPROVAL_EXCEEDS_REQUEST',
    );
  });

  it('sólo pendiente y activa no son finales', () => {
    expect(
      Object.values(S)
        .filter((e) => !esFinal(e))
        .sort(),
    ).toEqual([S.ACTIVE, S.PENDING].sort());
  });
});

describe('duración', () => {
  it.each([15, 30, 60, 120])('%i minutos vale para un pedido', (m) => {
    expect(() =>
      validarDuracion(m, SupportSessionKind.CONSENTED),
    ).not.toThrow();
  });

  it.each([0, 14, 16, 45, 90, 121, 240])(
    '%i minutos no vale (sólo 15, 30, 60 o 120)',
    (m) => {
      expect(() => validarDuracion(m, SupportSessionKind.CONSENTED)).toThrow(
        DuracionInvalidaError,
      );
    },
  );

  it('una emergencia llega a 60 minutos y no más', () => {
    expect(() =>
      validarDuracion(60, SupportSessionKind.EMERGENCY),
    ).not.toThrow();
    expect(() => validarDuracion(120, SupportSessionKind.EMERGENCY)).toThrow(
      'como máximo 60 minutos',
    );
  });

  it('el fin es el inicio más los minutos', () => {
    expect(
      finDeLaSesion(new Date('2026-11-13T10:00:00Z'), 30).toISOString(),
    ).toBe('2026-11-13T10:30:00.000Z');
  });
});

describe('aprobación', () => {
  const pedido = {
    minutos: 60,
    alcance: [SupportScope.PERSONAL_DATA, SupportScope.FILES],
  };

  it('sin valores se aprueba lo pedido', () => {
    expect(resolverAprobacion(pedido, {})).toEqual(pedido);
  });

  it('se puede acortar y achicar', () => {
    expect(
      resolverAprobacion(pedido, {
        minutos: 15,
        alcance: [SupportScope.FILES],
      }),
    ).toEqual({ minutos: 15, alcance: [SupportScope.FILES] });
  });

  it('el mismo largo vale (no es «más»)', () => {
    expect(resolverAprobacion(pedido, { minutos: 60 }).minutos).toBe(60);
  });

  it('no se puede alargar', () => {
    expect(() => resolverAprobacion(pedido, { minutos: 120 })).toThrow(
      AprobacionExcedeLoPedidoError,
    );
  });

  it('no se puede sumar alcance', () => {
    expect(() =>
      resolverAprobacion(pedido, { alcance: [SupportScope.EXPORTS] }),
    ).toThrow(AprobacionExcedeLoPedidoError);
  });

  it('una duración fuera de la lista no vale aunque sea menor', () => {
    expect(() => resolverAprobacion(pedido, { minutos: 20 })).toThrow(
      DuracionInvalidaError,
    );
  });

  it('una aprobación sin alcance deja lo básico', () => {
    expect(resolverAprobacion(pedido, { alcance: [] }).alcance).toEqual([]);
  });

  describe('assertAprobable', () => {
    const ahora = new Date('2026-11-13T10:00:00Z');

    it('pendiente y en plazo: se puede', () => {
      expect(() =>
        assertAprobable(S.PENDING, new Date('2026-11-13T10:00:01Z'), ahora),
      ).not.toThrow();
    });

    it('pendiente pero caducada (el plazo es exclusivo): 409 caducó', () => {
      expect(() => assertAprobable(S.PENDING, ahora, ahora)).toThrow(
        SolicitudCaducadaError,
      );
    });

    it('ya aprobada: 409 no está pendiente', () => {
      expect(() => assertAprobable(S.ACTIVE, null, ahora)).toThrow(
        SesionNoPendienteError,
      );
    });

    it('sin plazo no caduca', () => {
      expect(solicitudCaducada(null, ahora)).toBe(false);
    });
  });
});

describe('motivo de fin', () => {
  it.each([
    [A.SALIR, 'plataforma', SupportEndReason.EXIT],
    [A.VENCER, 'empresa', SupportEndReason.EXPIRED],
    [A.REVOCAR, 'empresa', SupportEndReason.REVOKED_BY_COMPANY],
    [A.REVOCAR, 'plataforma', SupportEndReason.REVOKED_BY_PLATFORM],
  ] as const)('%s por %s → %s', (accion, quien, motivo) => {
    expect(motivoDeFin(accion, quien)).toBe(motivo);
  });
});
