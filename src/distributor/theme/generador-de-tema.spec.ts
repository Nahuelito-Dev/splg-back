import {
  contraste,
  hexAOklch,
  luminancia,
  oklchAHex,
  redondearRelacion,
} from './color';
import {
  ACENTO_DEL_MENU_DE_BRASA,
  BLANCO,
  BRILLO_DEL_MENU,
  CROMA_CASI_GRIS,
  FONDO_DEL_ITEM_ACTIVO,
  mezclar,
  generarTema,
  MENU_NEUTRO,
  MINIMO_TEXTO,
  MINIMO_UI,
  PRINCIPAL_POR_OMISION,
  SUPERFICIES,
  SUPERFICIES_NEUTRAS,
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
    expect(tema.contrast).toHaveLength(28);
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

/** Las paletas preestablecidas del panel (`themePresets.ts`) y un color libre. */
const PALETAS: Array<[string, string, string | null]> = [
  ['Naranja SPLG', '#CD4B00', '#A86A00'],
  ['Amarillo gas', '#B58700', '#A87900'],
  ['Amarillo anaranjado', '#A85B00', '#A96A00'],
  ['Violeta', '#6D28D9', '#7B43C5'],
  ['Verde', '#0B6E3D', '#247A48'],
  ['Celeste', '#006C82', '#087B94'],
  ['Azul petróleo', '#075A6A', '#087287'],
  ['libre (frambuesa)', '#C2185B', null],
];

const ROLES_DEL_MENU = [
  'side',
  'sideRaised',
  'sideLine',
  'sideText',
  'sideMuted',
  'sideAccent',
] as const;
const ROLES_DE_SUPERFICIE = [
  'canvas',
  'surface',
  'surfaceHover',
  'surfaceSunken',
  'surfaceMuted',
  'outline',
  'outlineSoft',
] as const;

/** Distancia angular entre dos tonos (0 a 180). */
const distanciaDeTono = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe('menú lateral y oscuros del tono', () => {
  describe.each(PALETAS)('%s (%s)', (_, principal, acento) => {
    const tema = generarTema(principal, acento);
    const { light, dark } = tema.tokens;
    const tono = hexAOklch(principal).h;

    it('cumple todo el contraste, también el del menú', () => {
      expect(tema.failures).toEqual([]);
      expect(tema.contrast.filter((c) => !c.ok)).toEqual([]);
      for (const modo of ['light', 'dark'] as const) {
        const t = tema.tokens[modo];
        for (const texto of ['sideText', 'sideMuted', 'sideAccent'] as const) {
          for (const fondo of ['side', 'sideRaised'] as const) {
            expect(contraste(t[texto], t[fondo])).toBeGreaterThanOrEqual(
              MINIMO_TEXTO,
            );
          }
        }
      }
    });

    it('el texto del menú se lee bajo el brillo de arriba (el principal de cada modo al 22 %)', () => {
      for (const p of [light.primary, dark.primary]) {
        const brillo = mezclar(dark.side, p, BRILLO_DEL_MENU);
        expect(contraste(dark.sideText, brillo)).toBeGreaterThanOrEqual(
          MINIMO_TEXTO,
        );
        expect(contraste(dark.sideMuted, brillo)).toBeGreaterThanOrEqual(
          MINIMO_TEXTO,
        );
      }
    });

    it('el acento del menú: iniciales sobre el borde (4,5) e ícono sobre el ítem activo (3)', () => {
      expect(contraste(dark.sideAccent, dark.sideLine)).toBeGreaterThanOrEqual(
        MINIMO_TEXTO,
      );
      for (const p of [light.primary, dark.primary]) {
        expect(
          contraste(
            dark.sideAccent,
            mezclar(dark.side, p, FONDO_DEL_ITEM_ACTIVO),
          ),
        ).toBeGreaterThanOrEqual(MINIMO_UI);
      }
    });

    it('el menú es igual en claro y en oscuro', () => {
      for (const rol of ROLES_DEL_MENU) expect(light[rol]).toBe(dark[rol]);
    });

    it('el menú y las superficies oscuras toman el tono del principal y siguen siendo oscuros', () => {
      for (const rol of ['side', 'sideRaised', 'sideLine'] as const) {
        expect(dark[rol]).not.toBe(MENU_NEUTRO[rol]);
        expect(luminancia(dark[rol])).toBeLessThanOrEqual(
          luminancia(MENU_NEUTRO[rol]),
        );
        expect(
          distanciaDeTono(hexAOklch(dark[rol]).h, tono),
        ).toBeLessThanOrEqual(12);
      }
      for (const rol of ROLES_DE_SUPERFICIE) {
        expect(dark[rol]).not.toBe(SUPERFICIES_NEUTRAS.dark[rol]);
        // Nunca más claro que el neutro: todo texto claro que hoy cumple sigue cumpliendo.
        expect(luminancia(dark[rol])).toBeLessThanOrEqual(
          luminancia(SUPERFICIES_NEUTRAS.dark[rol]),
        );
        expect(hexAOklch(dark[rol]).c).toBeLessThanOrEqual(0.03);
      }
    });

    it('las superficies claras no cambian', () => {
      for (const rol of ROLES_DE_SUPERFICIE) {
        expect(light[rol]).toBe(SUPERFICIES_NEUTRAS.light[rol]);
      }
    });

    it('el principal oscuro se destaca sobre la superficie teñida', () => {
      expect(contraste(dark.primary, dark.surface)).toBeGreaterThanOrEqual(
        MINIMO_UI,
      );
      expect(
        contraste(dark.primaryStrong, dark.surface),
      ).toBeGreaterThanOrEqual(MINIMO_TEXTO);
    });
  });

  it.each([
    ['gris pizarra', '#4B5563'],
    ['gris puro', '#5A5A5A'],
    ['negro', '#000000'],
  ])(
    'un principal casi gris (%s, %s) deja los oscuros neutros de hoy',
    (_, principal) => {
      expect(hexAOklch(principal).c).toBeLessThan(CROMA_CASI_GRIS);
      const tema = generarTema(principal);
      expect(tema.contrast.filter((c) => !c.ok)).toEqual([]);
      for (const modo of ['light', 'dark'] as const) {
        expect(tema.tokens[modo]).toMatchObject(SUPERFICIES_NEUTRAS[modo]);
        expect(tema.tokens[modo]).toMatchObject(MENU_NEUTRO);
      }
    },
  );

  it('un principal apagado (#6B6B7F) da oscuros apagados: la croma no supera la del principal', () => {
    const principal = '#6B6B7F';
    const c = hexAOklch(principal).c;
    expect(c).toBeGreaterThanOrEqual(CROMA_CASI_GRIS);
    expect(c).toBeLessThan(0.045);
    const tema = generarTema(principal);
    expect(tema.contrast.filter((m) => !m.ok)).toEqual([]);
    const { dark } = tema.tokens;
    for (const rol of [...ROLES_DEL_MENU, ...ROLES_DE_SUPERFICIE]) {
      if (rol === 'sideAccent') continue;
      expect(hexAOklch(dark[rol]).c).toBeLessThanOrEqual(c + 0.005);
    }
  });

  it('el tema por omisión (oscuros de Brasa) da exactamente el menú y las superficies de Brasa', () => {
    const tema = generarTema(PRINCIPAL_POR_OMISION, null, {
      oscurosDeBrasa: true,
    });
    expect(tema.contrast.filter((m) => !m.ok)).toEqual([]);
    for (const modo of ['light', 'dark'] as const) {
      expect(tema.tokens[modo]).toMatchObject({
        ...SUPERFICIES_NEUTRAS[modo],
        ...MENU_NEUTRO,
        sideAccent: ACENTO_DEL_MENU_DE_BRASA,
      });
    }
    // Sin la opción, el mismo naranja tiñe los oscuros.
    expect(generarTema(PRINCIPAL_POR_OMISION).tokens.dark.side).not.toBe(
      MENU_NEUTRO.side,
    );
  });

  it('el menú neutro cumple 4,5:1, también bajo el brillo de Brasa', () => {
    for (const p of ['#D9530E', PRINCIPAL_POR_OMISION]) {
      const brillo = mezclar(MENU_NEUTRO.side, p, BRILLO_DEL_MENU);
      expect(contraste(MENU_NEUTRO.sideMuted, brillo)).toBeGreaterThanOrEqual(
        MINIMO_TEXTO,
      );
    }
    for (const texto of ['sideText', 'sideMuted'] as const) {
      for (const fondo of ['side', 'sideRaised'] as const) {
        expect(
          contraste(MENU_NEUTRO[texto], MENU_NEUTRO[fondo]),
        ).toBeGreaterThanOrEqual(MINIMO_TEXTO);
      }
    }
  });

  it('mide los pares del menú en los dos modos', () => {
    const pares = generarTema('#0B6E3D').contrast.map(
      (c) => `${c.mode}:${c.pair}`,
    );
    for (const modo of ['light', 'dark']) {
      for (const par of [
        'sideText/side',
        'sideText/sideRaised',
        'sideMuted/side',
        'sideMuted/sideRaised',
        'sideAccent/side',
        'sideAccent/sideRaised',
        'sideAccent/sideLine',
        'sideAccent/sideActive',
      ]) {
        expect(pares).toContain(`${modo}:${par}`);
      }
    }
  });
});
