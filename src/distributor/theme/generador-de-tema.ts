import {
  contraste,
  hexAOklch,
  hexARgb,
  luminancia,
  oklchAHex,
  rgbAHex,
  redondearRelacion,
  type Oklch,
} from './color';

/**
 * Generador del tema por distribuidora (diseño de la plataforma, §10.4). A
 * partir del color principal (y un acento opcional) deriva en OKLCH los roles
 * tematizables del panel y las apps, en claro y oscuro, y mide el contraste
 * WCAG 2.x de cada par que importa.
 *
 * Lo que elige la empresa (principal y acento, en claro) se valida y, si no
 * cumple, **no se ajusta en silencio**: `generarTema` devuelve las fallas con
 * una sugerencia del mismo tono que sí cumple. Lo derivado (el oscuro, el texto
 * fuerte sobre el suave, el acento que no se eligió) se corrige solo hasta
 * cumplir.
 *
 * Los oscuros también toman el tono de la marca: el menú lateral (siempre
 * oscuro) y las superficies del modo oscuro son un oscuro del mismo tono que el
 * principal, con croma baja para que se sigan leyendo como «oscuro». Si el
 * principal es casi gris quedan los oscuros neutros del panel. Las superficies
 * claras, la tinta y los colores de estado no se tematizan: una empresa cambia
 * su identidad, no la semántica del sistema.
 */

/** Los roles tematizables, iguales en claro y en oscuro. */
export interface TokensDeModo {
  primary: string;
  primaryHover: string;
  primaryStrong: string;
  primarySoft: string;
  onPrimary: string;
  accent: string;
  accentSoft: string;
  gradientFrom: string;
  gradientTo: string;
  gradientEdge: string;
  /** Fondo del panel. */
  canvas: string;
  /** Tarjetas, tablas y diálogos. */
  surface: string;
  surfaceHover: string;
  surfaceSunken: string;
  surfaceMuted: string;
  outline: string;
  outlineSoft: string;
  /** Menú lateral: siempre oscuro, igual en los dos modos. */
  side: string;
  /** Tarjetas y realces dentro del menú. */
  sideRaised: string;
  /** Divisores y bordes del menú. */
  sideLine: string;
  /** Texto de los ítems del menú. */
  sideText: string;
  /** Títulos de sección y texto secundario del menú. */
  sideMuted: string;
  /** Íconos activos, iniciales y foco dentro del menú. */
  sideAccent: string;
}

export interface TokensDelTema {
  light: TokensDeModo;
  dark: TokensDeModo;
}

export type ModoDelTema = 'light' | 'dark';

/** Un par medido. `pair` es `<frente>/<fondo>` con los nombres de los roles. */
export interface MedicionDeContraste {
  pair: string;
  mode: ModoDelTema;
  ratio: number;
  required: number;
  ok: boolean;
}

/** Un color elegido que no cumple, con la sugerencia del mismo tono. */
export interface FallaDeContraste {
  field: 'primaryColor' | 'accentColor';
  pair: string;
  ratio: number;
  required: number;
  suggestion: string;
}

export interface TemaGenerado {
  tokens: TokensDelTema;
  contrast: MedicionDeContraste[];
  failures: FallaDeContraste[];
}

/** Superficies fijas del modo claro (`brand.json`): contra ellas se valida lo elegido. */
export const SUPERFICIES = {
  surface: '#FFFFFF',
  canvas: '#F5F6F8',
  darkSurface: '#131A25',
  darkCanvas: '#0B0F16',
} as const;

type RolDeSuperficie =
  | 'canvas'
  | 'surface'
  | 'surfaceHover'
  | 'surfaceSunken'
  | 'surfaceMuted'
  | 'outline'
  | 'outlineSoft';

type RolDelMenu =
  | 'side'
  | 'sideRaised'
  | 'sideLine'
  | 'sideText'
  | 'sideMuted'
  | 'sideAccent';

export type SuperficiesDeModo = Record<RolDeSuperficie, string>;
export type ColoresDelMenu = Record<RolDelMenu, string>;

/** Las superficies neutras del panel (Brasa, `brand.json`), en claro y en oscuro. */
export const SUPERFICIES_NEUTRAS: Record<ModoDelTema, SuperficiesDeModo> = {
  light: {
    canvas: '#F5F6F8',
    surface: '#FFFFFF',
    surfaceHover: '#F5F6F8',
    surfaceSunken: '#FAFBFC',
    surfaceMuted: '#F0F2F5',
    outline: '#E7EAEE',
    outlineSoft: '#F0F2F5',
  },
  dark: {
    canvas: '#0B0F16',
    surface: '#131A25',
    surfaceHover: '#1B2330',
    surfaceSunken: '#171E29',
    surfaceMuted: '#212A38',
    outline: '#2E3847',
    outlineSoft: '#202836',
  },
};

/**
 * El menú neutro del panel: fondo, realce y borde de Brasa (el borde es el
 * blanco al 6 % sobre el fondo, ya compuesto) y el texto gris de siempre. El
 * secundario es el más oscuro que llega a 4,5:1 también bajo el brillo de Brasa.
 */
export const MENU_NEUTRO: Omit<ColoresDelMenu, 'sideAccent'> = {
  side: '#0B0F16',
  sideRaised: '#121824',
  sideLine: '#1A1E25',
  sideText: '#98A2B3',
  sideMuted: '#848C9D',
};

/**
 * Debajo de esta croma (OKLCH) el principal se ve gris: los oscuros quedan
 * neutros en vez de tomar un tono que nadie eligió.
 */
export const CROMA_CASI_GRIS = 0.03;

/**
 * Cuánto tono llevan los oscuros: poca croma, para que sigan siendo «oscuro», y
 * nunca más que la del principal (un principal apagado da oscuros apagados).
 */
const CROMA_DEL_MENU = 0.045;
const CROMA_DEL_TEXTO_DEL_MENU = 0.025;
const CROMA_DE_LAS_SUPERFICIES = 0.022;

/**
 * El acento del menú de Brasa (`llama-400`): el del tema por omisión, que el
 * panel muestra con sus propias variables.
 */
export const ACENTO_DEL_MENU_DE_BRASA = '#FF8A3D';

/**
 * Lo que el principal tiñe el fondo del menú, como lo pinta el panel: el brillo
 * de arriba (`.side-glow`, el principal al 22 % en su centro) y el ítem activo
 * (el principal al 16 %). Sobre esas mezclas también se mide.
 */
export const BRILLO_DEL_MENU = 0.22;
export const FONDO_DEL_ITEM_ACTIVO = 0.16;

/** `a` con `b` encima al `alfa` (0 a 1), compuesto en sRGB como lo hace el navegador. */
export function mezclar(a: string, b: string, alfa: number): string {
  const x = hexARgb(a);
  const y = hexARgb(b);
  return rgbAHex({
    r: x.r * (1 - alfa) + y.r * alfa,
    g: x.g * (1 - alfa) + y.g * alfa,
    b: x.b * (1 - alfa) + y.b * alfa,
  });
}

/** Texto sobre el principal: blanco o la tinta del panel. */
export const BLANCO = '#FFFFFF';
export const TINTA = '#0B1220';

export const MINIMO_TEXTO = 4.5;
export const MINIMO_UI = 3;

const PASO = 0.005;

const limitar = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

const conL = (o: Oklch, l: number): string =>
  oklchAHex({ ...o, l: limitar(l, 0, 1) });

/**
 * Texto sobre el principal: blanco si llega a 4,5:1 (la marca se ve como la
 * eligieron, con botones de texto blanco); si no, la tinta si llega; si ninguno
 * llega, el que más contraste da (y la validación lo rechaza).
 */
export function textoSobre(fondo: string): string {
  const blanco = contraste(BLANCO, fondo);
  if (blanco >= MINIMO_TEXTO) return BLANCO;
  const tinta = contraste(TINTA, fondo);
  if (tinta >= MINIMO_TEXTO) return TINTA;
  return blanco >= tinta ? BLANCO : TINTA;
}

/**
 * Mueve la luminosidad del color (mismo tono y croma) en `direccion` hasta que
 * `cumple` lo acepte. Si llega al extremo sin cumplir devuelve el extremo.
 */
function ajustarHasta(
  o: Oklch,
  direccion: 1 | -1,
  cumple: (hex: string) => boolean,
): string {
  for (let l = o.l; l >= 0 && l <= 1; l += direccion * PASO) {
    const hex = conL(o, l);
    if (cumple(hex)) return hex;
  }
  return conL(o, direccion > 0 ? 1 : 0);
}

/**
 * El color del mismo tono y croma más cercano en luminosidad que cumple: busca
 * hacia los dos lados y se queda con el de menor salto.
 */
export function sugerir(hex: string, cumple: (hex: string) => boolean): string {
  const o = hexAOklch(hex);
  for (let d = PASO; d <= 1; d += PASO) {
    for (const l of [o.l - d, o.l + d]) {
      if (l < 0 || l > 1) continue;
      const candidato = conL(o, l);
      if (cumple(candidato)) return candidato;
    }
  }
  return TINTA;
}

/** Los pares que tiene que cumplir el principal elegido (modo claro). */
function paresDelPrincipal(primary: string): Array<[string, number, number]> {
  return [
    [
      'onPrimary/primary',
      contraste(textoSobre(primary), primary),
      MINIMO_TEXTO,
    ],
    ['primary/surface', contraste(primary, SUPERFICIES.surface), MINIMO_UI],
    ['primary/canvas', contraste(primary, SUPERFICIES.canvas), MINIMO_UI],
  ];
}

const principalCumple = (hex: string) =>
  paresDelPrincipal(hex).every(([, r, min]) => r >= min);

const acentoCumple = (hex: string) =>
  contraste(hex, SUPERFICIES.surface) >= MINIMO_UI &&
  contraste(hex, SUPERFICIES.canvas) >= MINIMO_UI;

/** Lo que se mueve "alejándose" del texto: hover, gradiente y borde siguen legibles. */
function alejarDelTexto(o: Oklch, texto: string, cuanto: number): string {
  return conL(o, texto === BLANCO ? o.l - cuanto : o.l + cuanto);
}

function derivarModo(
  primary: string,
  accent: string,
  modo: ModoDelTema,
  superficies: SuperficiesDeModo,
  menu: ColoresDelMenu,
): TokensDeModo {
  const p = hexAOklch(primary);
  const a = hexAOklch(accent);
  const onPrimary = textoSobre(primary);

  const primarySoft =
    modo === 'light'
      ? conL({ ...p, c: Math.min(p.c * 0.25, 0.03) }, 0.97)
      : conL({ ...p, c: Math.min(p.c * 0.3, 0.05) }, 0.24);
  // El texto fuerte se usa sobre el suave y sobre la superficie: se lo aleja del
  // suave hasta 4,5:1.
  const fuerte: Oklch =
    modo === 'light'
      ? { ...p, l: Math.min(p.l - 0.08, 0.55) }
      : { ...p, c: Math.min(p.c, 0.15), l: Math.max(p.l + 0.1, 0.8) };
  const primaryStrong = ajustarHasta(
    fuerte,
    modo === 'light' ? -1 : 1,
    (hex) =>
      contraste(hex, primarySoft) >= MINIMO_TEXTO &&
      contraste(hex, superficies.surface) >= MINIMO_TEXTO,
  );

  const accentSoft =
    modo === 'light'
      ? conL({ ...a, c: Math.min(a.c * 0.3, 0.04) }, 0.97)
      : conL({ ...a, c: Math.min(a.c * 0.3, 0.05) }, 0.25);

  return {
    primary,
    primaryHover: alejarDelTexto(p, onPrimary, 0.05),
    primaryStrong,
    primarySoft,
    onPrimary,
    accent,
    accentSoft,
    gradientFrom: primary,
    gradientTo: alejarDelTexto(p, onPrimary, 0.06),
    gradientEdge: alejarDelTexto(p, onPrimary, 0.1),
    ...superficies,
    ...menu,
  };
}

/** El acento que no se eligió: el principal girado 35° hacia el amarillo, legible sobre blanco. */
function acentoDerivado(primary: string): string {
  const p = hexAOklch(primary);
  const base: Oklch = { l: 0.62, c: Math.min(p.c, 0.16), h: (p.h + 35) % 360 };
  return ajustarHasta(base, -1, acentoCumple);
}

/** En oscuro, el principal sube hasta destacarse sobre la superficie oscura con texto legible. */
function principalOscuro(primary: string, superficie: string): string {
  return ajustarHasta(
    hexAOklch(primary),
    1,
    (hex) =>
      contraste(hex, superficie) >= MINIMO_UI &&
      contraste(textoSobre(hex), hex) >= MINIMO_TEXTO,
  );
}

function acentoOscuro(accent: string, superficie: string): string {
  return ajustarHasta(
    hexAOklch(accent),
    1,
    (hex) => contraste(hex, superficie) >= MINIMO_UI,
  );
}

/** El matiz del principal (tono y croma OKLCH), o `null` si es casi gris. */
export interface Matiz {
  h: number;
  c: number;
}

export function matizDe(primary: string): Matiz | null {
  const p = hexAOklch(primary);
  return p.c < CROMA_CASI_GRIS ? null : { h: p.h, c: p.c };
}

/**
 * El oscuro neutro llevado al tono: misma luminosidad OKLCH, croma baja. Nunca
 * queda más claro (en luminancia WCAG) que el neutro: así todo texto claro que
 * hoy cumple sobre ese fondo sigue cumpliendo.
 */
function oscuroDelTono(neutro: string, tono: number, croma: number): string {
  const tope = luminancia(neutro);
  return ajustarHasta(
    { l: hexAOklch(neutro).l, c: croma, h: tono },
    -1,
    (hex) => luminancia(hex) <= tope,
  );
}

/** Las superficies del modo: neutras en claro (y sin tono); teñidas en oscuro. */
function superficiesDelModo(
  modo: ModoDelTema,
  matiz: Matiz | null,
): SuperficiesDeModo {
  const neutras = SUPERFICIES_NEUTRAS[modo];
  if (modo === 'light' || matiz === null) return { ...neutras };
  const croma = Math.min(CROMA_DE_LAS_SUPERFICIES, matiz.c);
  const alTono = (hex: string) => oscuroDelTono(hex, matiz.h, croma);
  return {
    canvas: alTono(neutras.canvas),
    surface: alTono(neutras.surface),
    surfaceHover: alTono(neutras.surfaceHover),
    surfaceSunken: alTono(neutras.surfaceSunken),
    surfaceMuted: alTono(neutras.surfaceMuted),
    outline: alTono(neutras.outline),
    outlineSoft: alTono(neutras.outlineSoft),
  };
}

/** Un color claro que se lee (≥ `minimo`) sobre cada uno de los fondos. */
const legibleSobre = (fondos: string[], minimo: number) => (hex: string) =>
  fondos.every((fondo) => contraste(hex, fondo) >= minimo);

/**
 * El menú lateral: el oscuro del tono del principal (o el neutro si es casi
 * gris o si es el tema por omisión), con croma acotada a la del principal.
 *
 * - Texto y secundario: 4,5:1 sobre el fondo, el realce y el fondo bajo el
 *   brillo de arriba (el principal de cada modo al 22 %).
 * - Acento (íconos activos, iniciales chicas, foco): 4,5:1 sobre el fondo, el
 *   realce y el borde (donde van las iniciales), y 3:1 sobre el ítem activo
 *   (el principal de cada modo al 16 %), donde pinta el ícono.
 */
function menuDelTema(
  matiz: Matiz | null,
  principales: string[],
  principalEnOscuro: string,
  acentoFijo: string | null,
): ColoresDelMenu {
  let base: Omit<ColoresDelMenu, 'sideAccent'> = { ...MENU_NEUTRO };
  if (matiz !== null) {
    const croma = Math.min(CROMA_DEL_MENU, matiz.c);
    const cromaDelTexto = Math.min(CROMA_DEL_TEXTO_DEL_MENU, matiz.c);
    const texto = (hex: string) => {
      const o = hexAOklch(hex);
      return conL({ ...o, c: cromaDelTexto, h: matiz.h }, o.l);
    };
    base = {
      side: oscuroDelTono(MENU_NEUTRO.side, matiz.h, croma),
      sideRaised: oscuroDelTono(MENU_NEUTRO.sideRaised, matiz.h, croma),
      sideLine: oscuroDelTono(MENU_NEUTRO.sideLine, matiz.h, croma),
      sideText: texto(MENU_NEUTRO.sideText),
      sideMuted: texto(MENU_NEUTRO.sideMuted),
    };
  }
  const bajoElBrillo = principales.map((p) =>
    mezclar(base.side, p, BRILLO_DEL_MENU),
  );
  const itemActivo = principales.map((p) =>
    mezclar(base.side, p, FONDO_DEL_ITEM_ACTIVO),
  );
  const textoLegible = legibleSobre(
    [base.side, base.sideRaised, ...bajoElBrillo],
    MINIMO_TEXTO,
  );
  const acentoLegible = (hex: string) =>
    legibleSobre(
      [base.side, base.sideRaised, base.sideLine],
      MINIMO_TEXTO,
    )(hex) && legibleSobre(itemActivo, MINIMO_UI)(hex);
  const subir = (hex: string, cumple: (hex: string) => boolean) =>
    cumple(hex) ? hex : ajustarHasta(hexAOklch(hex), 1, cumple);
  return {
    ...base,
    sideText: subir(base.sideText, textoLegible),
    sideMuted: subir(base.sideMuted, textoLegible),
    sideAccent: subir(acentoFijo ?? principalEnOscuro, acentoLegible),
  };
}

function medir(
  tokens: TokensDelTema,
  modo: ModoDelTema,
): MedicionDeContraste[] {
  const t = tokens[modo];
  const pares: Array<[string, string, string, number]> = [
    ['onPrimary/primary', t.onPrimary, t.primary, MINIMO_TEXTO],
    ['onPrimary/gradientTo', t.onPrimary, t.gradientTo, MINIMO_TEXTO],
    ['primary/surface', t.primary, t.surface, MINIMO_UI],
    ['primary/canvas', t.primary, t.canvas, MINIMO_UI],
    ['accent/surface', t.accent, t.surface, MINIMO_UI],
    ['primaryStrong/primarySoft', t.primaryStrong, t.primarySoft, MINIMO_TEXTO],
    ['sideText/side', t.sideText, t.side, MINIMO_TEXTO],
    ['sideText/sideRaised', t.sideText, t.sideRaised, MINIMO_TEXTO],
    ['sideMuted/side', t.sideMuted, t.side, MINIMO_TEXTO],
    ['sideMuted/sideRaised', t.sideMuted, t.sideRaised, MINIMO_TEXTO],
    ['sideAccent/side', t.sideAccent, t.side, MINIMO_TEXTO],
    ['sideAccent/sideRaised', t.sideAccent, t.sideRaised, MINIMO_TEXTO],
    ['sideAccent/sideLine', t.sideAccent, t.sideLine, MINIMO_TEXTO],
    [
      'sideAccent/sideActive',
      t.sideAccent,
      mezclar(t.side, t.primary, FONDO_DEL_ITEM_ACTIVO),
      MINIMO_UI,
    ],
  ];
  return pares.map(([pair, frente, fondo, required]) => {
    const ratio = contraste(frente, fondo);
    return {
      pair,
      mode: modo,
      ratio: redondearRelacion(ratio),
      required,
      ok: ratio >= required,
    };
  });
}

/**
 * Genera tokens y contraste. `primaryColor` y `accentColor` llegan ya
 * normalizados (`#RRGGBB` en mayúsculas). Si `failures` no está vacío, el tema
 * no se guarda: el servicio responde 400 con la primera falla.
 */
/** Opciones de `generarTema`. */
export interface OpcionesDelTema {
  /**
   * Menú y superficies exactamente los de Brasa (y su acento del menú): para el
   * tema por omisión, que el panel pinta con sus propias variables. Así lo que
   * devuelve la API es lo que se ve.
   */
  oscurosDeBrasa?: boolean;
}

export function generarTema(
  primaryColor: string,
  accentColor: string | null = null,
  opciones: OpcionesDelTema = {},
): TemaGenerado {
  const failures: FallaDeContraste[] = [];

  for (const [pair, ratio, required] of paresDelPrincipal(primaryColor)) {
    if (ratio < required) {
      failures.push({
        field: 'primaryColor',
        pair,
        ratio: redondearRelacion(ratio),
        required,
        suggestion: sugerir(primaryColor, principalCumple),
      });
    }
  }
  if (accentColor) {
    for (const [pair, fondo] of [
      ['accent/surface', SUPERFICIES.surface],
      ['accent/canvas', SUPERFICIES.canvas],
    ] as const) {
      const ratio = contraste(accentColor, fondo);
      if (ratio < MINIMO_UI) {
        failures.push({
          field: 'accentColor',
          pair,
          ratio: redondearRelacion(ratio),
          required: MINIMO_UI,
          suggestion: sugerir(accentColor, acentoCumple),
        });
      }
    }
  }

  const accent = accentColor ?? acentoDerivado(primaryColor);
  const matiz = opciones.oscurosDeBrasa ? null : matizDe(primaryColor);
  const claras = superficiesDelModo('light', matiz);
  const oscuras = superficiesDelModo('dark', matiz);
  const primaryOscuro = principalOscuro(primaryColor, oscuras.surface);
  const menu = menuDelTema(
    matiz,
    [primaryColor, primaryOscuro],
    primaryOscuro,
    opciones.oscurosDeBrasa ? ACENTO_DEL_MENU_DE_BRASA : null,
  );
  const tokens: TokensDelTema = {
    light: derivarModo(primaryColor, accent, 'light', claras, menu),
    dark: derivarModo(
      primaryOscuro,
      acentoOscuro(accent, oscuras.surface),
      'dark',
      oscuras,
      menu,
    ),
  };
  return {
    tokens,
    contrast: [...medir(tokens, 'light'), ...medir(tokens, 'dark')],
    failures,
  };
}

/**
 * Principal del tema por omisión (Brasa con el contraste corregido): el
 * `llama-600` del panel (`#D9530E`) da 4,04:1 con texto blanco; este es el
 * mismo tono, con texto blanco, y la luminosidad justa para 4,5:1.
 */
export const PRINCIPAL_POR_OMISION = sugerir(
  '#D9530E',
  (hex) => contraste(BLANCO, hex) >= MINIMO_TEXTO && principalCumple(hex),
);
