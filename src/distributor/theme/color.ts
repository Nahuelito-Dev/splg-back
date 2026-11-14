/**
 * Aritmética de color para el tema por distribuidora: sRGB ↔ OKLCH (Björn
 * Ottosson, https://bottosson.github.io/posts/oklab/) y contraste WCAG 2.x
 * (luminancia relativa). Todo puro y sin dependencias.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** `#RRGGBB` en mayúsculas: la única forma que guarda la base. */
export const COLOR_HEX = /^#[0-9A-F]{6}$/;

export function hexARgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbAHex({ r, g, b }: Rgb): string {
  const canal = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${canal(r)}${canal(g)}${canal(b)}`.toUpperCase();
}

const aLineal = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const desdeLineal = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
};

/** Luminancia relativa de WCAG 2.x (0 negro, 1 blanco). */
export function luminancia(hex: string): number {
  const { r, g, b } = hexARgb(hex);
  return 0.2126 * aLineal(r) + 0.7152 * aLineal(g) + 0.0722 * aLineal(b);
}

/** Relación de contraste WCAG entre dos colores (1 a 21). */
export function contraste(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Redondeo a dos decimales hacia abajo: un 4,499 no se muestra como 4,5. */
export function redondearRelacion(r: number): number {
  return Math.floor(r * 100) / 100;
}

export function hexAOklch(hex: string): Oklch {
  const { r, g, b } = hexARgb(hex);
  const lr = aLineal(r);
  const lg = aLineal(g);
  const lb = aLineal(b);
  const l_ = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m_ = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s_ = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(A * A + B * B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** OKLCH → sRGB lineal sin recortar (puede quedar fuera de [0, 1]). */
function oklchALineal({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L3 = l_ ** 3;
  const M3 = m_ ** 3;
  const S3 = s_ ** 3;
  return [
    4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3,
    -1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3,
    -0.0041960863 * L3 - 0.7034186147 * M3 + 1.707692607 * S3,
  ];
}

const dentroDeGamut = (lin: [number, number, number]): boolean =>
  lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * OKLCH → `#RRGGBB`. Si el color no entra en sRGB baja el croma (mismo tono y
 * luminosidad) hasta que entra: así una «sugerencia» sigue siendo el mismo tono.
 */
export function oklchAHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  let c = Math.max(0, color.c);
  if (!dentroDeGamut(oklchALineal({ l, c, h: color.h }))) {
    let bajo = 0;
    let alto = c;
    for (let i = 0; i < 30; i++) {
      const medio = (bajo + alto) / 2;
      if (dentroDeGamut(oklchALineal({ l, c: medio, h: color.h })))
        bajo = medio;
      else alto = medio;
    }
    c = bajo;
  }
  const [r, g, b] = oklchALineal({ l, c, h: color.h });
  return rgbAHex({
    r: desdeLineal(Math.min(1, Math.max(0, r))),
    g: desdeLineal(Math.min(1, Math.max(0, g))),
    b: desdeLineal(Math.min(1, Math.max(0, b))),
  });
}
