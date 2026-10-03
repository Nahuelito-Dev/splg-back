import { Readable } from 'stream';
import type { Response } from 'express';
import { contentDisposition, servirArchivo } from './servir-archivo';

describe('contentDisposition', () => {
  it("codifica también ' ( ) * en filename* (RFC 5987)", () => {
    const valor = contentDisposition("o'brien (1)*.pdf");
    expect(valor).toContain("filename*=UTF-8''o%27brien%20%281%29%2A.pdf");
  });

  it('deja una versión ASCII sin comillas ni acentos', () => {
    expect(contentDisposition('póliza "x".pdf')).toContain(
      'filename="p_liza _x_.pdf"',
    );
  });
});

describe('servirArchivo', () => {
  function respuesta(headersSent = false) {
    const res = {
      headersSent,
      set: jest.fn(),
      removeHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      destroy: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      emit: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    return res;
  }

  it('un error del stream responde 404 y no tira el proceso', () => {
    const res = respuesta();
    const stream = new Readable({ read() {} });
    servirArchivo(res as unknown as Response, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      stream,
      sizeBytes: 10,
    });
    stream.emit('error', new Error('ENOENT'));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.removeHeader).toHaveBeenCalledWith('Content-Length');
  });

  it('si ya se mandaron headers, corta la respuesta', () => {
    const res = respuesta(true);
    const stream = new Readable({ read() {} });
    servirArchivo(res as unknown as Response, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      stream,
      sizeBytes: null,
    });
    stream.emit('error', new Error('corte'));
    expect(res.destroy).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
