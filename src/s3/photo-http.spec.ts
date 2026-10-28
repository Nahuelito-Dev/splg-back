import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { DownloadMode } from './dto/download-link.dto';
import { aFotoVigente, responderFoto } from './photo-http';

function respuesta() {
  return { json: jest.fn(), redirect: jest.fn() };
}

describe('responderFoto', () => {
  const firmada = {
    kind: 'stored' as const,
    signed: { url: 'https://s3/firmada', expiresAt: new Date('2030-01-01') },
  };

  it('?modo=url con foto subida: JSON con la URL firmada y su vencimiento', () => {
    const res = respuesta();
    responderFoto(res as unknown as Response, DownloadMode.URL, firmada);
    expect(res.json).toHaveBeenCalledWith({
      url: 'https://s3/firmada',
      expiresAt: firmada.signed.expiresAt,
      requiresAuth: false,
    });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('?modo=url sin foto: 200 con url null', () => {
    const res = respuesta();
    responderFoto(res as unknown as Response, DownloadMode.URL, {
      kind: 'none',
    });
    expect(res.json).toHaveBeenCalledWith({
      url: null,
      expiresAt: null,
      requiresAuth: false,
    });
  });

  it('sin modo redirige (302) a la URL firmada', () => {
    const res = respuesta();
    responderFoto(res as unknown as Response, undefined, firmada);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://s3/firmada');
    expect(res.redirect).toHaveBeenCalledTimes(1);
  });

  it('sin modo y sin foto: 404', () => {
    const res = respuesta();
    expect(() =>
      responderFoto(res as unknown as Response, undefined, { kind: 'none' }),
    ).toThrow(NotFoundException);
  });
});

describe('aFotoVigente', () => {
  it('con foto: URL firmada y vencimiento, sin requiresAuth', () => {
    const signed = { url: 'https://s3/f', expiresAt: new Date('2030-01-01') };
    expect(aFotoVigente({ kind: 'stored', signed })).toEqual({
      url: signed.url,
      expiresAt: signed.expiresAt,
    });
  });

  it('sin foto: url y expiresAt null', () => {
    expect(aFotoVigente({ kind: 'none' })).toEqual({
      url: null,
      expiresAt: null,
    });
  });
});
