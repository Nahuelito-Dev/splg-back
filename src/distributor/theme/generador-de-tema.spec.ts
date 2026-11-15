import {
  contraste,
  hexAOklch,
  luminancia,
  oklchAHex,
  redondearRelacion,
} from './color';
import {
  BLANCO,
  generarTema,
  MINIMO_TEXTO,
  MINIMO_UI,
  PRINCIPAL_POR_OMISION,
  SUPERFICIES,
  sugerir,
  textoSobre,
  TINTA,
} from './generador-de-tema';

const HEX = /^#[0-9A-F]{6}$/;

describe('color (WCAG y OKLCH)', () => {
  it.each([
    ['#FFFFFF', '#000000', 21],
    ['#FFFFFF', '#FFFFFF', 1],
    ['#B8430B', '#FFFFFF', 5.46],
    ['#D24E0D', '#FFFFFF', 4.34],
  ])('contraste(%s, %s) = %s:1', (a, b, esperado) => {
    expect(redondearRelacion(contraste(a, b))).toBe(esperado);
    expect(contraste(a, b)).toBe(contraste(b, a));
  });

  it('luminancia en los extremos', () => {
    expect(luminancia('#000000')).toBe(0);
    expect(luminancia('#FFFFFF')).toBeCloseTo(1, 10);
  });

  it.each(['#D9530E', '#1D4ED8', '#0E7C3A', '#FEC84B', '#000000', '#FFFFFF'])(
    'ida y vuelta por OKLCH conserva %s',
    (hex) => {
      expect(oklchAHex(hexAOklch(hex))).toBe(hex);
    },
  );

  it('un color fuera de sRGB baja el croma y sigue siendo un #RRGGBB válido', () => {
    expect(oklchAHex({ l: 0.9, c: 0.4, h: 260 })).toMatch(HEX);
  });

  it('redondea hacia abajo: 4,499 no se muestra como 4,5', () => {
    expect(redondearRelacion(4.4999)).toBe(4.49);
  });
});

describe('textoSobre', () => {
  it('blanco si llega a 4,5:1', () => {
    expect(textoSobre('#1D4ED8')).toBe(BLANCO);
  });
  it('tinta si el blanco no llega y la tinta sí', () => {
    expect(textoSobre('#FEC84B')).toBe(TINTA);
    expect(textoSobre('#D9530E')).toBe(TINTA);
  });
});

describe('generarTema', () => {
  it.each([
    ['azul', '#1D4ED8'],
    ['verde', '#0E7C3A'],
    ['negro', '#000000'],
    ['por omisión', PRINCIPAL_POR_OMISION],
    ['naranja con texto tinta', '#D9530E'],
  ])('%s (%s) cumple: tokens válidos en claro y oscuro', (_, color) => {
    const tema = generarTema(color);
    expect(tema.failures).toEqual([]);
    for (const modo of ['light', 'dark'] as const) {
      for (const valor of Object.values(tema.tokens[modo])) {
        expect(valor).toMatch(HEX);
      }
    }
    expect(tema.tokens.light.primary).toBe(color);
    expect(tema.contrast.filter((c) => !c.ok)).toEqual([]);
    expect(tema.contrast).toHaveLength(12);
  });

  it('#FEC84B (amarillo) → falla contra el blanco con una sugerencia que sí cumple', () => {
    const { failures } = generarTema('#FEC84B');
    expect(failures[0]).toMatchObject({
      field: 'primaryColor',
      pair: 'primary/surface',
      ratio: 1.54,
      required: MINIMO_UI,
    });
    const sugerido = failures[0].suggestion;
    expect(sugerido).toMatch(HEX);
    expect(generarTema(sugerido).failures).toEqual([]);
    // Mismo tono: la sugerencia sólo mueve la luminosidad.
    expect(
      Math.abs(hexAOklch(sugerido).h - hexAOklch('#FEC84B').h),
    ).toBeLessThan(6);
  });

  it('blanco puro → falla contra el blanco y el fondo del panel', () => {
    const pares = generarTema('#FFFFFF').failures.map((f) => f.pair);
    expect(pares).toEqual(['primary/surface', 'primary/canvas']);
  });

  it('un gris medio sin texto que llegue a 4,5:1 falla en onPrimary/primary', () => {
    // Luminancia ≈ 0,19: el blanco da < 4,5 y la tinta también.
    const { failures } = generarTema('#7A7A7A');
    expect(failures.map((f) => f.pair)).toContain('onPrimary/primary');
    expect(generarTema(failures[0].suggestion).failures).toEqual([]);
  });

  it('valida el acento elegido contra el blanco, con sugerencia', () => {
    const { failures } = generarTema('#1D4ED8', '#FFB020');
    expect(failures[0]).toMatchObject({
      field: 'accentColor',
      pair: 'accent/surface',
      required: MINIMO_UI,
    });
    expect(
      contraste(failures[0].suggestion, SUPERFICIES.surface),
    ).toBeGreaterThanOrEqual(MINIMO_UI);
    expect(generarTema('#1D4ED8', failures[0].suggestion).failures).toEqual([]);
  });

  it('sin acento lo deriva legible sobre el blanco', () => {
    const { tokens } = generarTema('#1D4ED8');
    expect(
      contraste(tokens.light.accent, SUPERFICIES.surface),
    ).toBeGreaterThanOrEqual(MINIMO_UI);
  });

  it('con acento elegido lo respeta tal cual en claro', () => {
    expect(generarTema('#1D4ED8', '#7C3AED').tokens.light.accent).toBe(
      '#7C3AED',
    );
  });

  it('en oscuro sube el principal hasta destacarse sobre la superficie oscura', () => {
    const { tokens } = generarTema('#1E3A8A');
    expect(
      contraste(tokens.dark.primary, SUPERFICIES.darkSurface),
    ).toBeGreaterThanOrEqual(MINIMO_UI);
    expect(
      contraste(tokens.dark.onPrimary, tokens.dark.primary),
    ).toBeGreaterThanOrEqual(MINIMO_TEXTO);
    expect(tokens.light.primary).toBe('#1E3A8A');
  });

  it('el texto fuerte se lee sobre el suave en los dos modos', () => {
    const { tokens } = generarTema('#0E7C3A');
    for (const modo of ['light', 'dark'] as const) {
      expect(
        contraste(tokens[modo].primaryStrong, tokens[modo].primarySoft),
      ).toBeGreaterThanOrEqual(MINIMO_TEXTO);
    }
  });

  it('hover y gradiente se alejan del texto: el botón sigue legible', () => {
    for (const color of ['#1D4ED8', '#D9530E']) {
      const t = generarTema(color).tokens.light;
      expect(contraste(t.onPrimary, t.gradientTo)).toBeGreaterThanOrEqual(
        contraste(t.onPrimary, t.primary),
      );
      expect(contraste(t.onPrimary, t.primaryHover)).toBeGreaterThanOrEqual(
        contraste(t.onPrimary, t.primary),
      );
    }
  });

  it('es determinista: mismo color, mismos tokens', () => {
    expect(generarTema('#0E7C3A')).toEqual(generarTema('#0E7C3A'));
  });
});

describe('tema por omisión', () => {
  it('es el naranja de Brasa con texto blanco a 4,5:1', () => {
    expect(PRINCIPAL_POR_OMISION).toMatch(HEX);
    expect(contraste(BLANCO, PRINCIPAL_POR_OMISION)).toBeGreaterThanOrEqual(
      MINIMO_TEXTO,
    );
    expect(generarTema(PRINCIPAL_POR_OMISION).tokens.light.onPrimary).toBe(
      BLANCO,
    );
    expect(
      Math.abs(hexAOklch(PRINCIPAL_POR_OMISION).h - hexAOklch('#D9530E').h),
    ).toBeLessThan(6);
  });
});

describe('sugerir', () => {
  it('si nada cumple devuelve la tinta', () => {
    expect(sugerir('#1D4ED8', () => false)).toBe(TINTA);
  });
});
