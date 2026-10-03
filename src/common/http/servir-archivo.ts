import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'stream';
import { Logger } from '@nestjs/common';

const logger = new Logger('servirArchivo');

/**
 * Valor de `Content-Disposition: attachment` con el nombre original: una
 * versión ASCII para clientes viejos y la UTF-8 de la RFC 5987 para el resto.
 * `encodeURIComponent` deja pasar `' ( ) *`, que la RFC no admite en
 * `value-chars`: se codifican a mano.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export interface ArchivoParaServir {
  fileName: string;
  mimeType: string;
  stream: Readable;
  sizeBytes: number | null;
}

/**
 * Sirve el archivo por streaming. Escucha `error` del stream antes del pipe:
 * sin eso, un archivo que falta en disco (ENOENT) tira el proceso. Si todavía
 * no se mandaron headers responde 404; si ya se empezó a enviar, corta.
 */
export function servirArchivo(res: Response, archivo: ArchivoParaServir): void {
  archivo.stream.on('error', (error: Error) => {
    logger.error(
      `No se pudo leer el archivo ${archivo.fileName}: ${error.message}`,
    );
    if (!res.headersSent) {
      res.removeHeader('Content-Length');
      res.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'El archivo no está disponible',
      });
    } else {
      res.destroy(error);
    }
  });

  res.set({
    'Content-Type': archivo.mimeType,
    'Content-Disposition': contentDisposition(archivo.fileName),
    ...(archivo.sizeBytes
      ? { 'Content-Length': String(archivo.sizeBytes) }
      : {}),
  });
  archivo.stream.pipe(res);
}
