import {
  leerRespuestaEstructurada,
  MOTIVOS_DE_DERIVACION,
  MOTIVOS_EN_CASTELLANO,
  MotivoDeDerivacion,
  textoDeLaNotaDeDerivacion,
  textoParaElEquipo,
} from './asistente-ia.dominio';

describe('nota de derivación (4c) y salida estructurada (4d)', () => {
  it('todo motivo de derivación tiene su texto en castellano', () => {
    for (const m of MOTIVOS_DE_DERIVACION) {
      expect(MOTIVOS_EN_CASTELLANO[m]).toMatch(/^[A-ZÁÉÍÓÚ]/);
    }
  });

  it('con resumen: resumen y motivo (con el detalle del modelo); sin resumen, sólo el motivo', () => {
    expect(
      textoDeLaNotaDeDerivacion(
        MotivoDeDerivacion.REQUESTED,
        'Pide 2 garrafas.',
        'reclamo',
      ),
    ).toBe(
      'Resumen: Pide 2 garrafas.\nMotivo: El asistente no pudo resolverlo o la persona pidió hablar con alguien (reclamo)',
    );
    expect(
      textoDeLaNotaDeDerivacion(MotivoDeDerivacion.REPLY_LIMIT, null, null),
    ).toBe(
      'Motivo: Se llegó al tope de respuestas del asistente en esta conversación',
    );
  });

  it('el texto para el equipo: sin énfasis ni espacios de más, recortado; con HTML o vacío, nada', () => {
    expect(textoParaElEquipo(' **hola**   che \n\n  vos ', 100)).toBe(
      'hola che\nvos',
    );
    expect(textoParaElEquipo('abcdef', 4)).toBe('abc…');
    expect(textoParaElEquipo('<script>', 100)).toBeNull();
    expect(textoParaElEquipo('&amp;', 100)).toBeNull();
    expect(textoParaElEquipo('   ', 100)).toBeNull();
    expect(textoParaElEquipo(3, 100)).toBeNull();
    expect(textoParaElEquipo(undefined, 100)).toBeNull();
  });

  it('la salida estructurada: respuesta y preguntas (enteros positivos, sin repetir); lo demás, null', () => {
    expect(
      leerRespuestaEstructurada('{"respuesta":"Hola","preguntas":[3,3,1]}'),
    ).toEqual({ respuesta: 'Hola', preguntas: [3, 1] });
    expect(leerRespuestaEstructurada('{"respuesta":"Hola"}')).toEqual({
      respuesta: 'Hola',
      preguntas: [],
    });
    expect(
      leerRespuestaEstructurada('{"respuesta":"Hola","preguntas":["2",0]}'),
    ).toEqual({ respuesta: 'Hola', preguntas: [] });
    for (const malo of ['Hola', 'null', '[]', '{"preguntas":[]}', '{']) {
      expect(leerRespuestaEstructurada(malo)).toBeNull();
    }
  });
});
