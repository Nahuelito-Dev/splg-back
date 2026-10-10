import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import {
  DestinoDeFoto,
  EntityPhotoService,
  esUrlHttp,
  MAX_FOTO_BYTES,
} from './entity-photo.service';
import type { S3Service } from './s3.service';
import type { S3CleanupService } from './s3-cleanup.service';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('imagen'),
]);
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('imagen'),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([1, 2, 3, 4]),
  Buffer.from('WEBPVP8 '),
]);

function archivo(
  buffer: Buffer,
  mimetype: string,
  size = buffer.length,
): Express.Multer.File {
  return { buffer, mimetype, size } as Express.Multer.File;
}

describe('esUrlHttp', () => {
  it('acepta http(s) y rechaza el resto', () => {
    expect(esUrlHttp('https://x.example/a.png')).toBe(true);
    expect(esUrlHttp('http://x.example/a.png')).toBe(true);
    expect(esUrlHttp('javascript:alert(1)')).toBe(false);
    expect(esUrlHttp('no es una url')).toBe(false);
    expect(esUrlHttp(null)).toBe(false);
    expect(esUrlHttp(undefined)).toBe(false);
  });
});

describe('EntityPhotoService', () => {
  const DESTINO: DestinoDeFoto = {
    entity: class Fila {},
    idProp: 'id',
    keyProp: 'photoKey',
  };
  let fila: { id: string; photoKey: string | null } | null;
  let orden: string[];
  let storage: { put: jest.Mock; getSignedDownload: jest.Mock };
  let cleanup: {
    reserveUpload: jest.Mock;
    confirmUpload: jest.Mock;
    scheduleRemoval: jest.Mock;
    removeInBackground: jest.Mock;
  };
  let guardado: jest.Mock;
  let servicio: EntityPhotoService;

  beforeEach(() => {
    fila = { id: 'f1', photoKey: null };
    orden = [];
    storage = {
      put: jest.fn().mockImplementation(() => {
        orden.push('put');
        return Promise.resolve();
      }),
      getSignedDownload: jest.fn().mockResolvedValue({
        url: 'https://firmada/x',
        expiresAt: new Date('2030-01-01'),
      }),
    };
    cleanup = {
      reserveUpload: jest.fn().mockImplementation(() => {
        orden.push('reserve');
        return Promise.resolve();
      }),
      confirmUpload: jest.fn().mockResolvedValue(undefined),
      scheduleRemoval: jest.fn().mockResolvedValue(undefined),
      removeInBackground: jest.fn(),
    };
    guardado = jest.fn().mockResolvedValue(undefined);
    const manager = {
      createQueryBuilder: () => ({
        setLock: () => ({
          where: () => ({ getOne: () => Promise.resolve(fila) }),
        }),
      }),
      save: guardado,
    };
    const dataSource = {
      manager: {
        transaction: (fn: (m: EntityManager) => Promise<unknown>) =>
          fn(manager as unknown as EntityManager),
      },
    };
    servicio = new EntityPhotoService(
      dataSource as unknown as DataSource,
      storage as unknown as S3Service,
      cleanup as unknown as S3CleanupService,
    );
  });

  describe('validar', () => {
    it('sin archivo: 400', () => {
      expect(() => servicio.validar(undefined)).toThrow(BadRequestException);
    });

    it('archivo vacío: 400', () => {
      expect(() =>
        servicio.validar(archivo(Buffer.alloc(0), 'image/png')),
      ).toThrow(BadRequestException);
    });

    it('un tipo que no es imagen: 415', () => {
      expect(() =>
        servicio.validar(archivo(Buffer.from('%PDF-1.4'), 'application/pdf')),
      ).toThrow(UnsupportedMediaTypeException);
      expect(() => servicio.validar(archivo(PNG, 'image/gif'))).toThrow(
        UnsupportedMediaTypeException,
      );
    });

    it('más de 5 MB: 413', () => {
      expect(() =>
        servicio.validar(archivo(PNG, 'image/png', MAX_FOTO_BYTES + 1)),
      ).toThrow(PayloadTooLargeException);
    });

    it('exactamente 5 MB pasa', () => {
      expect(
        servicio.validar(archivo(PNG, 'image/png', MAX_FOTO_BYTES)).mime,
      ).toBe('image/png');
    });

    it('el contenido tiene que coincidir con el tipo declarado (magic bytes)', () => {
      // Un HTML disfrazado de PNG.
      expect(() =>
        servicio.validar(archivo(Buffer.from('<html></html>'), 'image/png')),
      ).toThrow(UnsupportedMediaTypeException);
      // Un PNG declarado como JPEG.
      expect(() => servicio.validar(archivo(PNG, 'image/jpeg'))).toThrow(
        UnsupportedMediaTypeException,
      );
      expect(() => servicio.validar(archivo(JPG, 'image/png'))).toThrow(
        UnsupportedMediaTypeException,
      );
    });

    it('acepta jpeg, png y webp válidos', () => {
      expect(servicio.validar(archivo(JPG, 'image/jpeg')).mime).toBe(
        'image/jpeg',
      );
      expect(servicio.validar(archivo(PNG, 'image/png')).mime).toBe(
        'image/png',
      );
      expect(servicio.validar(archivo(WEBP, 'image/webp')).mime).toBe(
        'image/webp',
      );
    });
  });

  describe('guardar', () => {
    it('reserva la key, sube, apunta la entidad y confirma la subida', async () => {
      await servicio.guardar(
        DESTINO,
        'f1',
        archivo(PNG, 'image/png'),
        'cars/d1/f1',
      );

      const key = fila?.photoKey ?? '';
      expect(key).toMatch(/^cars\/d1\/f1\/[0-9a-f-]{36}\.png$/);
      expect(orden).toEqual(['reserve', 'put']);
      expect(storage.put).toHaveBeenCalledWith({
        key,
        body: PNG,
        contentType: 'image/png',
      });
      expect(cleanup.confirmUpload).toHaveBeenCalledWith(
        expect.anything(),
        key,
      );
      expect(cleanup.scheduleRemoval).not.toHaveBeenCalled();
      expect(cleanup.removeInBackground).not.toHaveBeenCalled();
    });

    it('al reemplazar manda la foto anterior a limpieza', async () => {
      fila = { id: 'f1', photoKey: 'cars/d1/f1/vieja.png' };
      await servicio.guardar(
        DESTINO,
        'f1',
        archivo(JPG, 'image/jpeg'),
        'cars/d1/f1',
      );

      expect(cleanup.scheduleRemoval).toHaveBeenCalledWith(
        expect.anything(),
        'cars/d1/f1/vieja.png',
      );
      expect(cleanup.removeInBackground).toHaveBeenCalledWith(
        'cars/d1/f1/vieja.png',
      );
      expect(fila?.photoKey).toMatch(/\.jpg$/);
    });

    it('un archivo inválido no sube nada ni reserva', async () => {
      await expect(
        servicio.guardar(
          DESTINO,
          'f1',
          archivo(Buffer.from('x'), 'image/png'),
          'c',
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(cleanup.reserveUpload).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('si la entidad no existe, borra el objeto recién subido y da 404', async () => {
      fila = null;
      await expect(
        servicio.guardar(DESTINO, 'f1', archivo(PNG, 'image/png'), 'c'),
      ).rejects.toBeInstanceOf(NotFoundException);
      const key = (storage.put.mock.calls[0] as [{ key: string }])[0].key;
      expect(cleanup.removeInBackground).toHaveBeenCalledWith(key);
    });
  });

  describe('quitar', () => {
    it('deja la referencia en null y manda el objeto a limpieza', async () => {
      fila = { id: 'f1', photoKey: 'cars/d1/f1/a.png' };
      await servicio.quitar(DESTINO, 'f1');
      expect(fila?.photoKey).toBeNull();
      expect(cleanup.scheduleRemoval).toHaveBeenCalledWith(
        expect.anything(),
        'cars/d1/f1/a.png',
      );
      expect(cleanup.removeInBackground).toHaveBeenCalledWith(
        'cars/d1/f1/a.png',
      );
    });

    it('sin foto no hay nada que limpiar', async () => {
      await servicio.quitar(DESTINO, 'f1');
      expect(cleanup.scheduleRemoval).not.toHaveBeenCalled();
      expect(cleanup.removeInBackground).not.toHaveBeenCalled();
    });
  });

  describe('urlDe / firmar / enlace', () => {
    it('sin key es null y no firma', async () => {
      expect(await servicio.urlDe(null)).toBeNull();
      expect(storage.getSignedDownload).not.toHaveBeenCalled();
    });

    it('si la firma falla, no rompe la respuesta', async () => {
      storage.getSignedDownload.mockRejectedValueOnce(new Error('sin red'));
      expect(await servicio.urlDe('k')).toBeNull();
    });

    it('firmar completa photoSignedUrl en cada elemento', async () => {
      const items: Array<{ k: string | null; photoSignedUrl?: string | null }> =
        [{ k: 'a' }, { k: null }];
      await servicio.firmar(items, (i) => i.k);
      expect(items[0].photoSignedUrl).toBe('https://firmada/x');
      expect(items[1].photoSignedUrl).toBeNull();
    });

    it('enlace: la key manda, si no la URL http externa, si no nada', async () => {
      expect((await servicio.enlace('k', 'https://ext/x.png')).kind).toBe(
        'stored',
      );
      expect(await servicio.enlace(null, 'https://ext/x.png')).toEqual({
        kind: 'external',
        url: 'https://ext/x.png',
      });
      expect(await servicio.enlace(null, 'javascript:alert(1)')).toEqual({
        kind: 'none',
      });
      expect(await servicio.enlace(null)).toEqual({ kind: 'none' });
    });
  });
});
