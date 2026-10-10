/**
 * Imágenes de ejemplo para el seed de demostración. Se generan acá mismo
 * (PNG propio, sólo con `zlib`): no hay archivos bajados de internet ni
 * dependencias nuevas, y quedan libres de derechos.
 */
import { deflateSync } from 'zlib';

export type FiguraDemo = 'garrafa' | 'camioneta' | 'logo' | 'aviso';

type Rgb = readonly [number, number, number];

export interface OpcionesDeImagen {
  figura: FiguraDemo;
  /** Cambia los colores de una imagen a otra de la misma figura. */
  variante?: number;
  ancho?: number;
  alto?: number;
}

const PALETAS: Rgb[][] = [
  [
    [255, 183, 77],
    [239, 108, 0],
  ],
  [
    [129, 199, 132],
    [27, 94, 32],
  ],
  [
    [144, 202, 249],
    [21, 101, 192],
  ],
  [
    [244, 143, 177],
    [173, 20, 87],
  ],
];

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (const b of datos) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozo(tipo: string, datos: Buffer): Buffer {
  const cabecera = Buffer.alloc(8);
  cabecera.writeUInt32BE(datos.length, 0);
  cabecera.write(tipo, 4, 'ascii');
  const cuerpo = Buffer.concat([cabecera.subarray(4), datos]);
  const pie = Buffer.alloc(4);
  pie.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([cabecera.subarray(0, 4), cuerpo, pie]);
}

/** Codifica píxeles RGB (3 bytes por píxel, por filas) como PNG. */
function codificarPng(ancho: number, alto: number, rgb: Buffer): Buffer {
  const filas = Buffer.alloc((ancho * 3 + 1) * alto);
  for (let y = 0; y < alto; y++) {
    const destino = y * (ancho * 3 + 1);
    filas[destino] = 0; // sin filtro
    rgb.copy(filas, destino + 1, y * ancho * 3, (y + 1) * ancho * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(filas)),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

const mezclar = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Genera un PNG de ejemplo (degradé de fondo y una figura plana). */
export function generarImagenDemo(opciones: OpcionesDeImagen): Buffer {
  const { figura, variante = 0, ancho = 320, alto = 240 } = opciones;
  const [claro, oscuro] = PALETAS[variante % PALETAS.length];
  const BLANCO: Rgb = [250, 250, 250];
  const GRIS: Rgb = [55, 55, 60];
  const rgb = Buffer.alloc(ancho * alto * 3);

  const figuraEn = (x: number, y: number): Rgb | null => {
    const u = x / ancho;
    const v = y / alto;
    switch (figura) {
      case 'garrafa': {
        // Cuerpo redondeado, válvula y asa.
        const cuerpo =
          u > 0.35 &&
          u < 0.65 &&
          v > 0.3 &&
          v < 0.85 &&
          (v < 0.4 || v > 0.75
            ? Math.hypot(u - 0.5, v < 0.4 ? v - 0.4 : v - 0.75) < 0.15
            : true);
        if (cuerpo) return v > 0.5 && v < 0.62 ? BLANCO : oscuro;
        if (u > 0.46 && u < 0.54 && v > 0.18 && v <= 0.3) return GRIS;
        return null;
      }
      case 'camioneta': {
        const caja = u > 0.15 && u < 0.58 && v > 0.35 && v < 0.65;
        const cabina = u >= 0.58 && u < 0.85 && v > 0.45 && v < 0.65;
        const parabrisas = u > 0.65 && u < 0.78 && v > 0.49 && v < 0.57;
        if (parabrisas) return BLANCO;
        if (caja || cabina) return oscuro;
        for (const cx of [0.3, 0.72]) {
          if (Math.hypot((u - cx) * (ancho / alto), v - 0.68) < 0.09) {
            return GRIS;
          }
        }
        return null;
      }
      case 'logo': {
        const d = Math.hypot((u - 0.5) * (ancho / alto), v - 0.5);
        if (d < 0.18) return BLANCO;
        if (d < 0.34) return oscuro;
        return null;
      }
      case 'aviso': {
        // Triángulo de advertencia con el signo de exclamación.
        const dentro =
          v > 0.2 && v < 0.8 && Math.abs(u - 0.5) < (v - 0.2) * 0.5;
        if (!dentro) return null;
        const signo =
          Math.abs(u - 0.5) < 0.025 && v > 0.4 && v < 0.62
            ? true
            : Math.hypot((u - 0.5) * (ancho / alto), v - 0.7) < 0.03;
        return signo ? GRIS : BLANCO;
      }
    }
  };

  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const [r, g, b] =
        figuraEn(x, y) ?? mezclar(claro, oscuro, (x / ancho + y / alto) / 2);
      const i = (y * ancho + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return codificarPng(ancho, alto, rgb);
}
