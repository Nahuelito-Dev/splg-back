import {
  correspondeAtender,
  importeCanonico,
  importesDelTexto,
  importesNoVerificados,
  MotivoDeDerivacion,
  SIN_USO,
  type SituacionDelAsistente,
  sumarUso,
  textoPublicable,
  tokensQueCuentan,
  topeAlcanzado,
  CAUSAS_DE_DERIVACION,
  CAUSAS_EN_CASTELLANO,
  CausaDeDerivacion,
  causaDeDerivacion,
  prometeUnaAccion,
} from './asistente-ia.dominio';

describe('asistente con IA: reglas', () => {
  describe('textoPublicable', () => {
    it('deja texto plano: sin énfasis de Markdown, sin bordes ni saltos de más', () => {
      expect(
        textoPublicable('  **Hola**, abrimos a las __9__.\r\n\n\n\nChau  '),
      ).toBe('Hola, abrimos a las 9.\n\nChau');
    });

    it('vacío, con HTML (etiqueta o entidad) o de más de 2000 caracteres: no se publica', () => {
      expect(textoPublicable('   ** **  ')).toBeNull();
      expect(textoPublicable('Mirá <b>esto</b>')).toBeNull();
      expect(textoPublicable('Pan &amp; queso')).toBeNull();
      expect(textoPublicable('x'.repeat(2001))).toBeNull();
      expect(textoPublicable('x'.repeat(2000))).toHaveLength(2000);
    });

    it('un < o un & sueltos son texto', () => {
      expect(textoPublicable('Menos de < 5 kg y 3 & 4')).toBe(
        'Menos de < 5 kg y 3 & 4',
      );
    });
  });

  describe('correspondeAtender', () => {
    const base: SituacionDelAsistente = {
      activo: true,
      conversacionAbierta: true,
      personaAsignada: false,
      esperandoPersona: false,
      yaRespondido: false,
      hayUnoMasNuevo: false,
    };

    it('atiende sólo si está activo, abierta, sin persona, sin espera y sin respuesta', () => {
      expect(correspondeAtender(base)).toBe(true);
    });

    it.each([
      ['apagado', { activo: false }],
      ['cerrada', { conversacionAbierta: false }],
      ['alguien la tomó', { personaAsignada: true }],
      ['ya derivó', { esperandoPersona: true }],
      ['ya se respondió', { yaRespondido: true }],
      ['hay un mensaje más nuevo', { hayUnoMasNuevo: true }],
    ])('se calla si %s', (_caso, cambio) => {
      expect(correspondeAtender({ ...base, ...cambio })).toBe(false);
    });
  });

  describe('topes', () => {
    const topes = {
      respuestasPorConversacion: 10,
      tokensPorMes: 1000,
      tokensPorMesPorEmpresa: null,
    };
    const usados = (total: number, deLaEmpresa = 0) => ({ total, deLaEmpresa });

    it('sin pasarse, ninguno', () => {
      expect(topeAlcanzado(topes, 9, usados(999))).toBeNull();
    });

    it('al llegar a las respuestas por conversación o a los tokens del mes', () => {
      expect(topeAlcanzado(topes, 10, usados(0))).toBe(
        MotivoDeDerivacion.REPLY_LIMIT,
      );
      expect(topeAlcanzado(topes, 0, usados(1000))).toBe(
        MotivoDeDerivacion.MONTHLY_LIMIT,
      );
    });

    it('en el soporte, también al llegar al cupo de la empresa aunque la plataforma tenga margen', () => {
      const soporte = { ...topes, tokensPorMesPorEmpresa: 300 };
      expect(topeAlcanzado(soporte, 0, usados(500, 299))).toBeNull();
      expect(topeAlcanzado(soporte, 0, usados(500, 300))).toBe(
        MotivoDeDerivacion.MONTHLY_LIMIT,
      );
      // Sin cupo por empresa (C3), lo de la empresa no se mira dos veces.
      expect(topeAlcanzado(topes, 0, usados(500, 5000))).toBeNull();
    });
  });

  it('suma el uso y cuenta todo lo procesado (entrada, salida y caché)', () => {
    const uso = sumarUso(
      { ...SIN_USO, inputTokens: 10, outputTokens: 5 },
      {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 300,
        cacheCreationTokens: 40,
      },
    );
    expect(uso).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
    });
    expect(tokensQueCuentan(uso)).toBe(358);
  });

  describe('importes', () => {
    it('lee los formatos argentinos a una forma canónica', () => {
      expect(importeCanonico('12.345,50')).toBe('12345.50');
      expect(importeCanonico('15.000')).toBe('15000.00');
      expect(importeCanonico('1500')).toBe('1500.00');
      expect(importeCanonico('1500.5')).toBe('1500.50');
      expect(importeCanonico('2,5')).toBe('2.50');
      expect(importeCanonico('1.500.')).toBe('1500.00');
      expect(importeCanonico('1.2.3')).toBeNull();
    });

    it('encuentra los importes con $ o con «pesos» (no los porcentajes ni las cantidades)', () => {
      expect(
        importesDelTexto(
          'Sale $ 15.000, con 3 unidades $13.500,00; Mercado Pago 10 %, son 2000 pesos y 3 garrafas.',
        ),
      ).toEqual(['15000.00', '13500.00', '2000.00']);
    });

    it('marca los que no están en los datos de las herramientas', () => {
      expect(
        importesNoVerificados('Sale $ 15.000 o $ 14.000', [
          JSON.stringify({ precio: '$ 15.000,00' }),
        ]),
      ).toEqual(['14000.00']);
      expect(importesNoVerificados('Sin plata de por medio', [])).toEqual([]);
    });
  });
});

describe('ronda 1: causa de la derivación y promesas que no se cumplen', () => {
  it('causaDeDerivacion: las de la lista tal cual; lo demás, other', () => {
    expect(causaDeDerivacion('no_info')).toBe(CausaDeDerivacion.NO_INFO);
    expect(causaDeDerivacion('complaint')).toBe(CausaDeDerivacion.COMPLAINT);
    expect(causaDeDerivacion('NO_INFO')).toBe(CausaDeDerivacion.OTHER);
    expect(causaDeDerivacion(3)).toBe(CausaDeDerivacion.OTHER);
    expect(Object.keys(CAUSAS_EN_CASTELLANO).sort()).toEqual(
      [...CAUSAS_DE_DERIVACION].sort(),
    );
  });

  it.each([
    'Todavía no tengo información, para que alguien del equipo te oriente, quedó registrada tu consulta.',
    'Tu consulta queda anotada.',
    'Registré tu pedido de cambio.',
    'TOMÉ NOTA de lo que necesitás.',
    'Ya derivamos tu consulta.',
    'Le avisé a ventas.',
    'Te paso con alguien del equipo.',
    'Alguien te va a contactar mañana.',
  ])('promete una acción: «%s»', (t) => {
    expect(prometeUnaAccion(t)).toBe(true);
  });

  it.each([
    'Abrimos de lunes a sábado de 8 a 20.',
    'Tu pedido está Reservado (se activa el día agendado).',
    'Tu pedido fue registrado en la app y está en camino.',
    'Podés pagar en efectivo o con Mercado Pago.',
    'Te pasamos el link en la app.',
  ])('no promete nada: «%s»', (t) => {
    expect(prometeUnaAccion(t)).toBe(false);
  });
});
