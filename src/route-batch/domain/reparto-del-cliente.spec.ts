import {
  calcularReparto,
  type DatosDelReparto,
  redondearVentana,
  ventanaDelCliente,
} from './reparto-del-cliente';

const MIN = 60_000;
// 17/11/2026 15:00 en Argentina (UTC−3).
const T15 = Date.parse('2026-11-17T18:00:00Z');
const HOY = '2026-11-17';
const OPC = { hoy: HOY, mediaVentanaMinutos: 15 };

type Hoja = NonNullable<DatosDelReparto['hoja']>;

const hoja = (extra: Partial<Hoja> = {}): Hoja => ({
  enCurso: false,
  fecha: HOY,
  etaMs: T15 + 22 * MIN,
  ventanaAvisada: null,
  franja: { startMs: T15 - 60 * MIN, endMs: T15 + 120 * MIN },
  intentosFallidos: 0,
  entregasAntes: 4,
  ...extra,
});

const datos = (extra: Partial<DatosDelReparto> = {}): DatosDelReparto => ({
  estadoDelPedido: 'accepted',
  fechaDelPedido: HOY,
  hoja: null,
  ultimaSalida: null,
  ...extra,
});

describe('reparto del pedido para su cliente (puro)', () => {
  it('redondea la franja hacia afuera de a 5 minutos (nunca la achica)', () => {
    expect(
      redondearVentana({ startMs: T15 + 7 * MIN, endMs: T15 + 37 * MIN }),
    ).toEqual({ startMs: T15 + 5 * MIN, endMs: T15 + 40 * MIN });
    expect(
      redondearVentana({ startMs: T15 + 9 * MIN, endMs: T15 + 31 * MIN }),
    ).toEqual({ startMs: T15 + 5 * MIN, endMs: T15 + 35 * MIN });
    expect(
      redondearVentana({ startMs: T15 + 5 * MIN, endMs: T15 + 40 * MIN }),
    ).toEqual({ startMs: T15 + 5 * MIN, endMs: T15 + 40 * MIN });
  });

  it('la franja: la avisada si la hay; si no, ± la media sobre la hora estimada dentro de la franja comprada; sin hora o sin franja, ninguna', () => {
    const avisada = { startMs: T15, endMs: T15 + 30 * MIN };
    expect(ventanaDelCliente(hoja({ ventanaAvisada: avisada }), 15)).toBe(
      avisada,
    );
    expect(ventanaDelCliente(hoja(), 15)).toEqual({
      startMs: T15 + 7 * MIN,
      endMs: T15 + 37 * MIN,
    });
    expect(ventanaDelCliente(hoja({ etaMs: null }), 15)).toBeNull();
    expect(ventanaDelCliente(hoja({ franja: null }), 15)).toBeNull();
  });

  it('entregado o cancelado: sin reparto, aunque la parada siga activa', () => {
    for (const estadoDelPedido of ['delivered', 'cancelled']) {
      expect(
        calcularReparto(
          datos({ estadoDelPedido, hoja: hoja({ enCurso: true }) }),
          OPC,
        ),
      ).toBeNull();
    }
  });

  it('sin hoja: sin hoja de ruta, sin hora ni entregas antes', () => {
    expect(calcularReparto(datos(), OPC)).toEqual({
      situacion: 'sin_hoja_de_ruta',
      diaDelReparto: null,
      viajeIniciado: false,
      entregasAntes: null,
      ventana: null,
      pasoAlFinalDelRecorrido: false,
      reprogramadoPara: null,
    });
  });

  it('en una hoja confirmada: no arrancó, da la franja estimada redondeada y NO las entregas antes', () => {
    expect(calcularReparto(datos({ hoja: hoja() }), OPC)).toEqual({
      situacion: 'en_hoja_sin_salir',
      diaDelReparto: HOY,
      viajeIniciado: false,
      entregasAntes: null,
      ventana: { startMs: T15 + 5 * MIN, endMs: T15 + 40 * MIN },
      pasoAlFinalDelRecorrido: false,
      reprogramadoPara: null,
    });
  });

  it('en viaje: cuántas entregas hay antes; si el suyo está en camino, ninguna', () => {
    const r = calcularReparto(datos({ hoja: hoja({ enCurso: true }) }), OPC);
    expect(r).toEqual(
      expect.objectContaining({
        situacion: 'en_viaje',
        viajeIniciado: true,
        entregasAntes: 4,
        pasoAlFinalDelRecorrido: false,
      }),
    );
    expect(
      calcularReparto(
        datos({
          estadoDelPedido: 'on_the_way',
          hoja: hoja({ enCurso: true }),
        }),
        OPC,
      )?.entregasAntes,
    ).toBe(0);
  });

  it('reencolado (primer intento fallido): pasó al final del recorrido, con la franja nueva avisada', () => {
    const avisada = { startMs: T15 + 120 * MIN, endMs: T15 + 150 * MIN };
    expect(
      calcularReparto(
        datos({
          hoja: hoja({
            enCurso: true,
            intentosFallidos: 1,
            ventanaAvisada: avisada,
          }),
        }),
        OPC,
      ),
    ).toEqual(
      expect.objectContaining({
        situacion: 'en_viaje',
        pasoAlFinalDelRecorrido: true,
        ventana: avisada,
      }),
    );
  });

  it('reprogramado: salió de la hoja sin entregarse y tiene fecha nueva posterior', () => {
    expect(
      calcularReparto(
        datos({
          estadoDelPedido: 'pending',
          fechaDelPedido: '2026-11-18',
          ultimaSalida: { motivo: 'rescheduled', fechaDeLaHoja: HOY },
        }),
        OPC,
      ),
    ).toEqual(
      expect.objectContaining({
        situacion: 'reprogramado',
        reprogramadoPara: '2026-11-18',
        ventana: null,
      }),
    );
  });

  it('salió sin entregarse y sin fecha nueva: espera que el equipo le ponga fecha', () => {
    for (const motivo of ['needs_reschedule', 'sheet_closed', 'rescheduled']) {
      expect(
        calcularReparto(
          datos({
            estadoDelPedido: 'pending',
            fechaDelPedido: HOY,
            ultimaSalida: { motivo, fechaDeLaHoja: HOY },
          }),
          OPC,
        )?.situacion,
      ).toBe('sin_fecha_nueva');
    }
  });

  it('la fecha nueva que ya pasó no se dice como reprogramación; otras salidas no cuentan', () => {
    expect(
      calcularReparto(
        datos({
          estadoDelPedido: 'pending',
          fechaDelPedido: '2026-11-16',
          ultimaSalida: { motivo: 'rescheduled', fechaDeLaHoja: '2026-11-13' },
        }),
        OPC,
      )?.situacion,
    ).toBe('sin_hoja_de_ruta');
    for (const motivo of ['moved', 'admin', null]) {
      expect(
        calcularReparto(
          datos({ ultimaSalida: { motivo, fechaDeLaHoja: '2026-11-13' } }),
          OPC,
        )?.situacion,
      ).toBe('sin_hoja_de_ruta');
    }
  });

  it('si vuelve a estar en una hoja, manda la hoja (no la reprogramación vieja)', () => {
    expect(
      calcularReparto(
        datos({
          fechaDelPedido: '2026-11-18',
          hoja: hoja({ fecha: '2026-11-18' }),
          ultimaSalida: { motivo: 'rescheduled', fechaDeLaHoja: HOY },
        }),
        OPC,
      )?.situacion,
    ).toBe('en_hoja_sin_salir');
  });
});
