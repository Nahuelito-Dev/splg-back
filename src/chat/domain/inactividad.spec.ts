import {
  type AvisoDado,
  decidirInactividad,
  type EstadoDeInactividad,
  inicioDelCiclo,
  plazosValidos,
  textoDelAviso,
} from './inactividad';

const T0 = new Date('2026-11-16T12:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

/** El último que cuenta, a `T0`, de quien se diga. */
const respondio = (
  ultimo: EstadoDeInactividad['ultimo'],
  aviso: AvisoDado | null = null,
  reabiertaAt: Date | null = null,
): EstadoDeInactividad => ({
  ultimo,
  ultimoAt: T0,
  reabiertaAt,
  aviso,
  esperandoPersona: false,
});

const aviso = (at: number, cierra: number): AvisoDado => ({
  at: min(at),
  cierraAt: min(cierra),
});

describe('cierre por inactividad (7c): la decisión, con reloj fijo', () => {
  const sinAviso = { cerrarMinutos: 60, avisarMinutos: null };
  const conAviso = { cerrarMinutos: 60, avisarMinutos: 15 };

  it('apagado: nunca hace nada', () => {
    expect(
      decidirInactividad(
        respondio('team'),
        { cerrarMinutos: null, avisarMinutos: null },
        min(100_000),
      ),
    ).toEqual({ accion: 'nada' });
  });

  it('si el último es del cliente o del chofer, nunca cierra (espera al equipo)', () => {
    expect(
      decidirInactividad(respondio('person'), sinAviso, min(10_000)),
    ).toEqual({ accion: 'nada' });
    expect(decidirInactividad(respondio(null), sinAviso, min(10_000))).toEqual({
      accion: 'nada',
    });
  });

  it('si espera a una persona (el asistente la derivó), nunca cierra', () => {
    expect(
      decidirInactividad(
        { ...respondio('assistant'), esperandoPersona: true },
        sinAviso,
        min(10_000),
      ),
    ).toEqual({ accion: 'nada' });
  });

  it('sin aviso: cierra justo al cumplirse el plazo desde la respuesta del equipo o del asistente', () => {
    for (const quien of ['team', 'assistant'] as const) {
      expect(decidirInactividad(respondio(quien), sinAviso, min(59))).toEqual({
        accion: 'nada',
      });
      expect(decidirInactividad(respondio(quien), sinAviso, min(60))).toEqual({
        accion: 'cerrar',
      });
    }
  });

  it('con aviso: avisa a los (cierre − aviso) minutos, prometiendo los minutos del aviso', () => {
    expect(decidirInactividad(respondio('team'), conAviso, min(44))).toEqual({
      accion: 'nada',
    });
    expect(decidirInactividad(respondio('team'), conAviso, min(45))).toEqual({
      accion: 'avisar',
      minutos: 15,
      cierraAt: min(60),
    });
  });

  it('con aviso: sin avisar no cierra aunque haya pasado el plazo (avisa primero y corre el cierre)', () => {
    expect(decidirInactividad(respondio('team'), conAviso, min(200))).toEqual({
      accion: 'avisar',
      minutos: 15,
      cierraAt: min(215),
    });
  });

  it('avisada en el ciclo: cierra cuando pasan el plazo y el cierre que se mostró', () => {
    // Aviso a tiempo (a los 45, «cerramos a los 60»).
    expect(
      decidirInactividad(respondio('team', aviso(45, 60)), conAviso, min(59)),
    ).toEqual({ accion: 'nada' });
    expect(
      decidirInactividad(respondio('team', aviso(45, 60)), conAviso, min(60)),
    ).toEqual({ accion: 'cerrar' });
    // Aviso tarde (a los 55, «cerramos a los 70»): no antes de los 70.
    expect(
      decidirInactividad(respondio('team', aviso(55, 70)), conAviso, min(65)),
    ).toEqual({ accion: 'nada' });
    expect(
      decidirInactividad(respondio('team', aviso(55, 70)), conAviso, min(70)),
    ).toEqual({ accion: 'cerrar' });
  });

  it('nunca cierra antes del cierre que se mostró, aunque se haya achicado o apagado el aviso', () => {
    // Avisó «cerramos a los 90»; ahora el aviso está apagado y el plazo es 60.
    expect(
      decidirInactividad(respondio('team', aviso(30, 90)), sinAviso, min(75)),
    ).toEqual({ accion: 'nada' });
    expect(
      decidirInactividad(respondio('team', aviso(30, 90)), sinAviso, min(90)),
    ).toEqual({ accion: 'cerrar' });
  });

  it('un aviso anterior al último mensaje que cuenta no vale: se vuelve a avisar', () => {
    expect(
      decidirInactividad(respondio('team', aviso(-30, -15)), conAviso, min(46)),
    ).toEqual({ accion: 'avisar', minutos: 15, cierraAt: min(61) });
  });

  describe('reapertura', () => {
    it('el ciclo arranca en la reapertura: reabierta hace un rato no se cierra en la corrida siguiente', () => {
      // El equipo escribió a T0 y se cerró; la reabren a los 500.
      const reabierta = respondio('team', null, min(500));
      expect(decidirInactividad(reabierta, sinAviso, min(505))).toEqual({
        accion: 'nada',
      });
      expect(decidirInactividad(reabierta, sinAviso, min(559))).toEqual({
        accion: 'nada',
      });
      expect(decidirInactividad(reabierta, sinAviso, min(560))).toEqual({
        accion: 'cerrar',
      });
    });

    it('el aviso del ciclo anterior a la reapertura no vale: vuelve a avisar', () => {
      const reabierta = respondio('team', aviso(45, 60), min(500));
      expect(decidirInactividad(reabierta, conAviso, min(545))).toEqual({
        accion: 'avisar',
        minutos: 15,
        cierraAt: min(560),
      });
    });

    it('una reapertura vieja, con un mensaje del equipo después, no corre nada', () => {
      expect(
        inicioDelCiclo({ ultimoAt: T0, reabiertaAt: min(-100) }, null),
      ).toEqual(T0);
    });
  });

  describe('desde cuándo rigen los plazos', () => {
    const recienPrendido = { ...sinAviso, habilitadoAt: min(10_000) };

    it('al prenderlo no cierra el atraso de golpe: cuenta desde que se prendió', () => {
      expect(
        decidirInactividad(respondio('team'), recienPrendido, min(10_001)),
      ).toEqual({ accion: 'nada' });
      expect(
        decidirInactividad(respondio('team'), recienPrendido, min(10_060)),
      ).toEqual({ accion: 'cerrar' });
    });

    it('un aviso de antes de apagarlo y volver a prenderlo no vale: se vuelve a avisar', () => {
      expect(
        decidirInactividad(
          respondio('team', aviso(45, 60)),
          { ...conAviso, habilitadoAt: min(1_000) },
          min(1_045),
        ),
      ).toEqual({ accion: 'avisar', minutos: 15, cierraAt: min(1_060) });
    });
  });

  it('plazos válidos: cierre de 30 a 10080 y aviso de 5 a 1440, antes del cierre', () => {
    const v = (c: number | null, a: number | null) =>
      plazosValidos({ cerrarMinutos: c, avisarMinutos: a });
    expect([
      v(null, null),
      v(30, null),
      v(10080, 1440),
      v(60, 59),
      v(29, null),
      v(10081, null),
      v(60, 60),
      v(60, 4),
      v(5000, 1441),
      v(null, 10),
      v(60.5, null),
    ]).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('el texto del aviso', () => {
    expect(textoDelAviso(15)).toBe(
      'Si no tenés más consultas, cerramos la conversación en 15 min.',
    );
    expect(textoDelAviso(60)).toBe(
      'Si no tenés más consultas, cerramos la conversación en 1 h.',
    );
    expect(textoDelAviso(90)).toBe(
      'Si no tenés más consultas, cerramos la conversación en 1 h 30 min.',
    );
  });
});
