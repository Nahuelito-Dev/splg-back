import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';
import {
  MAX_PIXELES,
  Semaforo,
  limpiarMetadatosDeImagen,
} from './limpiar-imagen';
import {
  MARCA_DE_EXIF,
  imagenesDePrueba,
  tieneExif,
} from './imagenes-de-prueba';

describe('limpiarMetadatosDeImagen', () => {
  it('un JPEG con GPS sale sin EXIF y sigue siendo un JPEG de las mismas dimensiones', async () => {
    const entrada = await imagenesDePrueba.jpeg(true);
    // La entrada de verdad trae el GPS (si no, el test no prueba nada).
    expect(entrada.includes(MARCA_DE_EXIF)).toBe(true);
    expect((await sharp(entrada).metadata()).exif).toBeDefined();

    const salida = await limpiarMetadatosDeImagen(entrada, 'image/jpeg');

    const meta = await sharp(salida).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(salida.includes(MARCA_DE_EXIF)).toBe(false);
    expect(salida.includes(Buffer.from('rastreador'))).toBe(false);
    expect([meta.width, meta.height]).toEqual([40, 20]);
  });

  it('aplica la orientación del EXIF a los píxeles antes de descartarla', async () => {
    const entrada = await imagenesDePrueba.jpegGirado();
    expect((await sharp(entrada).metadata()).orientation).toBe(6);

    const meta = await sharp(
      await limpiarMetadatosDeImagen(entrada, 'image/jpeg'),
    ).metadata();

    // 90°: el alto y el ancho se intercambian y ya no queda orientación.
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(meta.orientation).toBeUndefined();
  });

  it('un PNG con EXIF sale sin EXIF', async () => {
    const entrada = await imagenesDePrueba.png(true);
    expect((await sharp(entrada).metadata()).exif).toBeDefined();

    const salida = await limpiarMetadatosDeImagen(entrada, 'image/png');

    const meta = await sharp(salida).metadata();
    expect(meta.format).toBe('png');
    expect(meta.exif).toBeUndefined();
    expect(salida.includes(MARCA_DE_EXIF)).toBe(false);
  });

  it('un WEBP con EXIF sale sin EXIF', async () => {
    const entrada = await imagenesDePrueba.webp(true);
    expect((await sharp(entrada).metadata()).exif).toBeDefined();

    const salida = await limpiarMetadatosDeImagen(entrada, 'image/webp');

    const meta = await sharp(salida).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(salida.includes(MARCA_DE_EXIF)).toBe(false);
  });

  it('el PDF pasa sin tocarse', async () => {
    const pdf = Buffer.from('%PDF-1.4 contenido');
    await expect(
      limpiarMetadatosDeImagen(pdf, 'application/pdf'),
    ).resolves.toBe(pdf);
  });

  it('una imagen con la firma correcta pero contenido dañado se rechaza con 415', async () => {
    const dañada = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('no es una foto'),
    ]);
    await expect(
      limpiarMetadatosDeImagen(dañada, 'image/jpeg'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('las imágenes de prueba sin GPS no traen EXIF y las dos variantes coinciden en formato', async () => {
    for (const formato of ['jpeg', 'png', 'webp'] as const) {
      const limpia = await imagenesDePrueba[formato]();
      const conGps = await imagenesDePrueba[formato](true);
      expect(await tieneExif(limpia)).toBe(false);
      expect(await tieneExif(conGps)).toBe(true);
      expect((await sharp(limpia).metadata()).format).toBe(formato);
    }
  });

  describe('imágenes enormes (amplificación de memoria)', () => {
    /** Un JPEG liso de ~poco peso que declara muchos megapíxeles. */
    const enorme = (ancho: number, alto: number) =>
      sharp({
        create: {
          width: ancho,
          height: alto,
          channels: 3,
          background: { r: 10, g: 10, b: 10 },
        },
      })
        .jpeg({ quality: 20 })
        .withMetadata({ orientation: 6 })
        .toBuffer();

    it('7000×7000 (49 MP, con orientación) se rechaza con 413 antes de decodificarlo', async () => {
      const entrada = await enorme(7000, 7000);
      expect(entrada.length).toBeLessThan(2 * 1024 * 1024);
      const antes = process.memoryUsage().rss;
      await expect(
        limpiarMetadatosDeImagen(entrada, 'image/jpeg'),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      // No decodificó: no hay un salto de cientos de MB.
      expect(process.memoryUsage().rss - antes).toBeLessThan(150 * 1024 * 1024);
    });

    it('justo sobre el tope se rechaza y justo debajo se acepta', async () => {
      const lado = Math.floor(Math.sqrt(MAX_PIXELES));
      await expect(
        limpiarMetadatosDeImagen(await enorme(lado + 50, lado), 'image/jpeg'),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      const ok = await limpiarMetadatosDeImagen(
        await enorme(4000, 3000),
        'image/jpeg',
      );
      expect(ok.length).toBeGreaterThan(0);
    });

    it('las imágenes simultáneas se procesan de a lo sumo 2', async () => {
      const semaforo = new Semaforo(2);
      let activas = 0;
      let maximo = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          semaforo.correr(async () => {
            activas += 1;
            maximo = Math.max(maximo, activas);
            await new Promise((r) => setTimeout(r, 10));
            activas -= 1;
          }),
        ),
      );
      expect(maximo).toBe(2);
    });

    it('el semáforo libera el cupo aunque el trabajo falle', async () => {
      const semaforo = new Semaforo(1);
      await expect(
        semaforo.correr(() => Promise.reject(new Error('falla'))),
      ).rejects.toThrow('falla');
      await expect(semaforo.correr(() => Promise.resolve(1))).resolves.toBe(1);
    });
  });
});
