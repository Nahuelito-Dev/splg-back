import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  Controller,
  INestApplication,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import {
  archivoConTope,
  MAX_FOTO_BYTES,
  opcionesDeSubida,
} from './upload-limits';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';

function fuentes(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return fuentes(ruta);
    return ruta.endsWith('.ts') && !ruta.endsWith('.spec.ts') ? [ruta] : [];
  });
}

describe('tope de tamaño de las subidas', () => {
  it('los topes son los de negocio (5 MB fotos, 10 MB adjuntos)', () => {
    expect(MAX_FOTO_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ningún endpoint arma un FileInterceptor sin pasar por archivoConTope', () => {
    const sueltos = fuentes(join(__dirname, '..'))
      .filter((f) => !f.endsWith('upload-limits.ts'))
      .filter((f) =>
        /\b(FileInterceptor|FilesInterceptor|AnyFilesInterceptor|FileFieldsInterceptor)\b/.test(
          readFileSync(f, 'utf8'),
        ),
      );
    expect(sueltos).toEqual([]);
  });

  it('opcionesDeSubida pone los límites en multer', () => {
    expect(opcionesDeSubida(1234).limits).toEqual({
      fileSize: 1234,
      files: 1,
      fields: 5,
      fieldSize: 64 * 1024,
      parts: 6,
    });
  });

  describe('contra multer real', () => {
    @Controller()
    class PruebaController {
      @Post('foto')
      @UseInterceptors(archivoConTope(1024 * 1024, 'foto'))
      foto(@UploadedFile() f: Express.Multer.File | undefined) {
        return { size: f?.size ?? 0 };
      }

      @Post('archivo')
      @UseInterceptors(archivoConTope(10 * 1024 * 1024, 'archivo'))
      archivo(@UploadedFile() f: Express.Multer.File | undefined) {
        return { size: f?.size ?? 0 };
      }
    }
    let app: INestApplication;
    beforeAll(async () => {
      const m = await Test.createTestingModule({
        controllers: [PruebaController],
      }).compile();
      app = m.createNestApplication();
      await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
    });
    afterAll(() => app.close());
    const http = () => request(app.getHttpServer() as Server);

    it('un archivo dentro del tope pasa', async () => {
      await http()
        .post('/foto')
        .attach('file', Buffer.alloc(100), 'a.png')
        .field('label', 'ok')
        .expect(201);
    });

    it('413 en castellano y con el máximo', async () => {
      const foto = await http()
        .post('/foto')
        .attach('file', Buffer.alloc(1024 * 1024 + 1), 'a.png')
        .expect(413);
      expect((foto.body as { message: string }).message).toBe(
        'La foto supera el máximo permitido (1 MB)',
      );
      const arch = await http()
        .post('/archivo')
        .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'a.pdf')
        .expect(413);
      expect((arch.body as { message: string }).message).toBe(
        'El archivo supera el máximo permitido (10 MB)',
      );
    });

    it('muchos campos de texto: 400', async () => {
      let req = http().post('/foto').attach('file', Buffer.alloc(10), 'a.png');
      for (let i = 0; i < 20; i++) req = req.field(`c${i}`, 'x');
      const res = await req.expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /demasiados campos/,
      );
    });

    it('un campo de texto enorme: 400, sin cargarlo en memoria', async () => {
      await http()
        .post('/foto')
        .attach('file', Buffer.alloc(10), 'a.png')
        .field('label', 'x'.repeat(65 * 1024))
        .expect(400);
    });

    it('muchos campos grandes juntos: se cortan (400 o conexión cerrada)', async () => {
      let req = http().post('/foto');
      for (let i = 0; i < 30; i++)
        req = req.field(`c${i}`, 'x'.repeat(60 * 1024));
      const resultado = await req.then(
        (res) => res.status,
        (error: { code?: string }) => error.code,
      );
      expect([400, 'ECONNRESET', 'EPIPE']).toContain(resultado);
    });
  });
});
