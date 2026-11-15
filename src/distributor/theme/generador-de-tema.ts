import {
  contraste,
  hexAOklch,
  oklchAHex,
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
 * No se tematizan la tinta, las superficies, los colores de estado ni el menú
 * lateral: una empresa cambia su identidad, no la semántica del sistema.
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

/** Superficies fijas del panel (`brand.json`): contra ellas se mide. */
export const SUPERFICIES = {
  surface: '#FFFFFF',
  canvas: '#F5F6F8',
  darkSurface: '#131A25',
  darkCanvas: '#0B0F16',
} as const;

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
      contraste(
        hex,
        modo === 'light' ? SUPERFICIES.surface : SUPERFICIES.darkSurface,
      ) >= MINIMO_TEXTO,
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
  };
}

/** El acento que no se eligió: el principal girado 35° hacia el amarillo, legible sobre blanco. */
function acentoDerivado(primary: string): string {
  const p = hexAOklch(primary);
  const base: Oklch = { l: 0.62, c: Math.min(p.c, 0.16), h: (p.h + 35) % 360 };
  return ajustarHasta(base, -1, acentoCumple);
}

/** En oscuro, el principal sube hasta destacarse sobre la superficie oscura con texto legible. */
function principalOscuro(primary: string): string {
  return ajustarHasta(
    hexAOklch(primary),
    1,
    (hex) =>
      contraste(hex, SUPERFICIES.darkSurface) >= MINIMO_UI &&
      contraste(textoSobre(hex), hex) >= MINIMO_TEXTO,
  );
}

function acentoOscuro(accent: string): string {
  return ajustarHasta(
    hexAOklch(accent),
    1,
    (hex) => contraste(hex, SUPERFICIES.darkSurface) >= MINIMO_UI,
  );
}

function medir(
  tokens: TokensDelTema,
  modo: ModoDelTema,
): MedicionDeContraste[] {
  const t = tokens[modo];
  const superficie =
    modo === 'light' ? SUPERFICIES.surface : SUPERFICIES.darkSurface;
  const lienzo = modo === 'light' ? SUPERFICIES.canvas : SUPERFICIES.darkCanvas;
  const pares: Array<[string, string, string, number]> = [
    ['onPrimary/primary', t.onPrimary, t.primary, MINIMO_TEXTO],
    ['onPrimary/gradientTo', t.onPrimary, t.gradientTo, MINIMO_TEXTO],
    ['primary/surface', t.primary, superficie, MINIMO_UI],
    ['primary/canvas', t.primary, lienzo, MINIMO_UI],
    ['accent/surface', t.accent, superficie, MINIMO_UI],
    ['primaryStrong/primarySoft', t.primaryStrong, t.primarySoft, MINIMO_TEXTO],
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
export function generarTema(
  primaryColor: string,
  accentColor: string | null = null,
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
  const tokens: TokensDelTema = {
    light: derivarModo(primaryColor, accent, 'light'),
    dark: derivarModo(
      principalOscuro(primaryColor),
      acentoOscuro(accent),
      'dark',
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
