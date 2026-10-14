import sharp from 'sharp';

/** EXIF de una foto de celular: cámara, programa y coordenadas GPS. */
export const EXIF_CON_GPS = {
  IFD0: { Make: 'CamaraDePrueba', Software: 'rastreador 1.0' },
  IFD3: {
    GPSLatitudeRef: 'S',
    GPSLatitude: '34/1 36/1 0/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '58/1 22/1 0/1',
  },
};

/** Texto que sólo está en los archivos si conservaron el EXIF de `EXIF_CON_GPS`. */
export const MARCA_DE_EXIF = Buffer.from('CamaraDePrueba');

function lienzo(ancho = 40, alto = 20) {
  return sharp({
    create: {
      width: ancho,
      height: alto,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  });
}

/** Imágenes reales y mínimas para los tests (el back las decodifica). */
export const imagenesDePrueba = {
  jpeg: (conGps = false): Promise<Buffer> =>
    (conGps
      ? lienzo().jpeg().withExif(EXIF_CON_GPS)
      : lienzo().jpeg()
    ).toBuffer(),
  png: (conGps = false): Promise<Buffer> =>
    (conGps
      ? lienzo().png().withExif(EXIF_CON_GPS)
      : lienzo().png()
    ).toBuffer(),
  webp: (conGps = false): Promise<Buffer> =>
    (conGps
      ? lienzo().webp().withExif(EXIF_CON_GPS)
      : lienzo().webp()
    ).toBuffer(),
  /** JPEG con orientación 6 (girado 90°) en el EXIF. */
  jpegGirado: (): Promise<Buffer> =>
    lienzo().jpeg().withMetadata({ orientation: 6 }).toBuffer(),
};

/** ¿Conserva metadata EXIF? */
export async function tieneExif(imagen: Buffer): Promise<boolean> {
  const meta = await sharp(imagen).metadata();
  return meta.exif !== undefined || imagen.includes(MARCA_DE_EXIF);
}
