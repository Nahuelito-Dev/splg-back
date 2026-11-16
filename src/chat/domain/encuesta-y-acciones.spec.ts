import {
  ACCIONES_POR_DEFECTO,
  accionesHabilitadas,
  accionParaMandar,
  CLAVES_DE_ACCION,
} from './acciones-del-cliente';
import {
  AccionNoDisponibleError,
  AccionSoloDeLaAppError,
  CalificacionAnuladaError,
  CalificacionNoDisponibleError,
  CalificacionVencidaError,
  CalificacionYaRespondidaError,
} from './chat.errors';
import {
  type EncuestaPedida,
  estadoDeLaEncuesta,
  quienAtendio,
  respuestaALaEncuesta,
  venceLaEncuesta,
} from './encuesta';

const AHORA = new Date('2026-11-15T15:00:00Z');

describe('encuesta de satisfacción (4b)', () => {
  it('vence a las 48 h', () => {
    expect(venceLaEncuesta(AHORA)).toEqual(new Date('2026-11-17T15:00:00Z'));
  });

  it('quién atendió: el equipo si escribió; si no, el asistente si respondió; si no, nadie', () => {
    expect(quienAtendio(true, true)).toBe('team');
    expect(quienAtendio(false, true)).toBe('assistant');
    expect(quienAtendio(false, false)).toBe('none');
  });

  const pendiente = (
    cambios: Partial<EncuestaPedida> = {},
  ): EncuestaPedida => ({
    score: null,
    comment: null,
    answeredAt: null,
    cancelledAt: null,
    expiresAt: new Date('2026-11-15T15:00:00Z'),
    ...cambios,
  });
  const resp = { score: 4, comment: null };

  it('se responde una vez, cerrada y antes de vencer (el borde vale): nueva', () => {
    expect(respuestaALaEncuesta(pendiente(), resp, false, AHORA)).toBe('nueva');
  });

  it('sin encuesta → 404; anulada o con la conversación abierta → 409; vencida → 409', () => {
    expect(() => respuestaALaEncuesta(null, resp, false, AHORA)).toThrow(
      CalificacionNoDisponibleError,
    );
    expect(() =>
      respuestaALaEncuesta(
        pendiente({ cancelledAt: AHORA }),
        resp,
        false,
        AHORA,
      ),
    ).toThrow(CalificacionAnuladaError);
    expect(() => respuestaALaEncuesta(pendiente(), resp, true, AHORA)).toThrow(
      CalificacionAnuladaError,
    );
    expect(() =>
      respuestaALaEncuesta(
        pendiente({ expiresAt: new Date(AHORA.getTime() - 1) }),
        resp,
        false,
        AHORA,
      ),
    ).toThrow(CalificacionVencidaError);
  });

  it('ya respondida: la misma respuesta es un reintento (aunque ya venció o se reabrió); otra → 409', () => {
    const respondida = pendiente({
      score: 4,
      comment: 'Bien',
      answeredAt: AHORA,
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(
      respuestaALaEncuesta(
        respondida,
        { score: 4, comment: 'Bien' },
        true,
        AHORA,
      ),
    ).toBe('repetida');
    for (const otra of [
      { score: 5, comment: 'Bien' },
      { score: 4, comment: null },
    ]) {
      expect(() =>
        respuestaALaEncuesta(respondida, otra, false, AHORA),
      ).toThrow(CalificacionYaRespondidaError);
    }
  });

  it('estado: respondida, anulada, pendiente o vencida', () => {
    const futuro = new Date('2099-01-01T00:00:00Z');
    expect(
      estadoDeLaEncuesta(
        pendiente({ answeredAt: AHORA, expiresAt: futuro }),
        AHORA,
      ),
    ).toBe('answered');
    expect(
      estadoDeLaEncuesta(
        pendiente({ cancelledAt: AHORA, expiresAt: futuro }),
        AHORA,
      ),
    ).toBe('cancelled');
    expect(estadoDeLaEncuesta(pendiente({ expiresAt: futuro }), AHORA)).toBe(
      'pending',
    );
    expect(
      estadoDeLaEncuesta(
        pendiente({ expiresAt: new Date('2026-01-01T00:00:00Z') }),
        AHORA,
      ),
    ).toBe('expired');
  });
});

describe('botones de acción del cliente (4e)', () => {
  it('por omisión, todas, en el orden del catálogo', () => {
    expect(accionesHabilitadas(ACCIONES_POR_DEFECTO).map((a) => a.key)).toEqual(
      [...CLAVES_DE_ACCION],
    );
  });

  it('las habilitadas salen en el orden del catálogo, sin las desconocidas', () => {
    expect(
      accionesHabilitadas(['talk_to_person', 'otra', 'where_is_my_order']).map(
        (a) => a.key,
      ),
    ).toEqual(['where_is_my_order', 'talk_to_person']);
  });

  it('mandar: las de mensaje y la de pasar a una persona; la de la app o una no habilitada, 400', () => {
    expect(
      accionParaMandar('payment_methods', ACCIONES_POR_DEFECTO),
    ).toMatchObject({ kind: 'message', text: '¿Qué medios de pago aceptan?' });
    expect(
      accionParaMandar('talk_to_person', ACCIONES_POR_DEFECTO),
    ).toMatchObject({
      kind: 'handoff',
      text: 'Quiero hablar con una persona.',
    });
    expect(() =>
      accionParaMandar('repeat_last_order', ACCIONES_POR_DEFECTO),
    ).toThrow(AccionSoloDeLaAppError);
    expect(() => accionParaMandar('payment_methods', [])).toThrow(
      AccionNoDisponibleError,
    );
  });
});
