import { createHash } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import {
  DocumentReaderPort,
  LecturaDeDocumento,
} from '../document-reader/document-reader.port';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { RedisService } from '../redis/redis.service';
import { DocumentReadingService } from './document-reading.service';
import {
  DocumentReading,
  DocumentReadingStatus,
} from './entities/document-reading.entity';

const archivo = {
  buffer: Buffer.from('%PDF comprobante'),
  mimeType: 'application/pdf',
};
const huella = createHash('sha256').update(archivo.buffer).digest('hex');

const lectura = (
  extra: Partial<LecturaDeDocumento> = {},
): LecturaDeDocumento => ({
  tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  legible: true,
  campos: [{ nombre: 'importe', valor: '38390.00', confianza: 'alta' }],
  avisos: [],
  uso: {
    modelo: 'claude-opus-5-5',
    tokensDeEntrada: 1000,
    tokensDeSalida: 200,
    costoUsd: 0.008,
  },
  ...extra,
});

/** El cerrojo de Redis, que ejecuta la operación como si lo hubiera obtenido. */
const redisQueEjecuta = {
  withLock: <T>(_k: string, _t: number, fn: () => Promise<T>) =>
    fn().then((valor) => ({ obtenido: true as const, valor })),
} as unknown as RedisService;

function armar(opciones: {
  existente?: Partial<DocumentReading> | null;
  original?: Partial<DocumentReading> | null;
  leido?: LecturaDeDocumento | null;
  disponible?: boolean;
}) {
  const findOne = jest
    .fn()
    .mockResolvedValueOnce(opciones.existente ?? null)
    .mockResolvedValueOnce(opciones.original ?? null);
  const save = jest.fn((r: DocumentReading) =>
    Promise.resolve({ ...r, readingId: r.readingId ?? 'nueva' }),
  );
  const repo = {
    findOne,
    // Como el de TypeORM: devuelve sólo lo que recibe, sin los valores por omisión de la base.
    create: jest.fn((d: Partial<DocumentReading>) => ({ ...d })),
    save,
  } as unknown as Repository<DocumentReading>;
  const leer = jest
    .fn()
    .mockResolvedValue(
      opciones.leido === undefined ? lectura() : opciones.leido,
    );
  const lector = {
    disponible: opciones.disponible ?? true,
    leer,
  } as unknown as DocumentReaderPort;
  return {
    service: new DocumentReadingService(repo, lector, redisQueEjecuta),
    guardar: save,
    leer,
    findOne,
  };
}

const documento = {
  distributorId: 'dist-a',
  attachmentId: 'adj-1',
  archivo,
  opciones: { tipoEsperado: TipoDeDocumento.COMPROBANTE_DE_PAGO },
};

describe('DocumentReadingService.leerAdjunto', () => {
  it('lee el adjunto y guarda tipo, campos, avisos, modelo, tokens, costo y huella', async () => {
    const { service, leer, guardar } = armar({});
    const { registro, lectura: leida } = await service.leerAdjunto(documento);
    expect(leer).toHaveBeenCalledWith(archivo, documento.opciones);
    expect(registro).toMatchObject({
      distributorId: 'dist-a',
      attachmentId: 'adj-1',
      fileSha256: huella,
      expectedType: 'comprobante_de_pago',
      detectedType: 'comprobante_de_pago',
      status: DocumentReadingStatus.READ,
      legible: true,
      fields: [{ nombre: 'importe', valor: '38390.00', confianza: 'alta' }],
      model: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.008,
      attempts: 1,
      lastError: null,
    });
    expect(registro.readAt).toBeInstanceOf(Date);
    expect(leida?.tipo).toBe('comprobante_de_pago');
    expect(guardar).toHaveBeenCalledTimes(1);
  });

  it('un documento que no se lee queda como ilegible', async () => {
    const { service } = armar({
      leido: lectura({ legible: false, campos: [] }),
    });
    const { registro } = await service.leerAdjunto(documento);
    expect(registro.status).toBe(DocumentReadingStatus.UNREADABLE);
  });

  it('si ya se leyó ese adjunto, no vuelve a llamar al servicio', async () => {
    const { service, leer } = armar({
      existente: {
        readingId: 'r-1',
        status: DocumentReadingStatus.READ,
        detectedType: TipoDeDocumento.POLIZA,
        legible: true,
        fields: [],
        warnings: [],
        inputTokens: 900,
        outputTokens: 100,
        costUsd: 0.006,
        model: 'claude-opus-5-5',
      },
    });
    const { registro, lectura: leida } = await service.leerAdjunto(documento);
    expect(leer).not.toHaveBeenCalled();
    expect(registro.readingId).toBe('r-1');
    expect(leida?.tipo).toBe('poliza');
  });

  it('el mismo archivo de otro adjunto ya leído: duplicado, copia sus datos y no gasta', async () => {
    const leidoEl = new Date('2026-11-01T12:00:00Z');
    const { service, leer } = armar({
      original: {
        readingId: 'r-original',
        status: DocumentReadingStatus.CONFIRMED,
        detectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
        legible: true,
        fields: [{ nombre: 'importe', valor: '100.00', confianza: 'alta' }],
        warnings: ['aviso del original'],
        readAt: leidoEl,
      },
    });
    const { registro, lectura: leida } = await service.leerAdjunto(documento);
    expect(leer).not.toHaveBeenCalled();
    expect(registro).toMatchObject({
      status: DocumentReadingStatus.DUPLICATE,
      duplicateOfId: 'r-original',
      detectedType: 'comprobante_de_pago',
      fields: [{ nombre: 'importe', valor: '100.00', confianza: 'alta' }],
      costUsd: 0,
      attempts: 0,
    });
    expect(registro.warnings[0]).toContain('ya se había cargado el 1/11/2026');
    expect(registro.warnings).toContain('aviso del original');
    expect(leida?.uso.costoUsd).toBe(0);
  });

  it('si el servicio falla, queda fallida con el error y se puede reintentar sumando intentos', async () => {
    const { service } = armar({ leido: null });
    const { registro, lectura: leida } = await service.leerAdjunto(documento);
    expect(leida).toBeNull();
    expect(registro.readAt ?? null).toBeNull();
    expect(registro).toMatchObject({
      status: DocumentReadingStatus.FAILED,
      attempts: 1,
      lastError: expect.any(String) as string,
    });
    const reintento = armar({ existente: { ...registro, attempts: 1 } });
    const otra = await reintento.service.leerAdjunto(documento);
    expect(otra.registro).toMatchObject({
      status: DocumentReadingStatus.READ,
      attempts: 2,
    });
  });

  it('sin lector configurado guarda la lectura pendiente y no llama a nada', async () => {
    const { service, leer } = armar({ disponible: false });
    const { registro, lectura: leida } = await service.leerAdjunto(documento);
    expect(leer).not.toHaveBeenCalled();
    expect(leida).toBeNull();
    expect(registro.status).toBe(DocumentReadingStatus.PENDING);
  });

  it('busca el original sólo en la misma distribuidora y en otro adjunto', async () => {
    const { service, findOne } = armar({});
    await service.leerAdjunto(documento);
    const where = (
      findOne.mock.calls[1] as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where).toMatchObject({
      distributorId: 'dist-a',
      fileSha256: huella,
    });
    expect(where.attachmentId).toBeDefined();
  });
});

describe('DocumentReadingService.obtener', () => {
  it('404 si no existe o es de otra distribuidora', async () => {
    const buscar = jest.fn<Promise<null>, [unknown]>().mockResolvedValue(null);
    const repo = { findOne: buscar } as unknown as Repository<DocumentReading>;
    const service = new DocumentReadingService(
      repo,
      { disponible: true } as DocumentReaderPort,
      redisQueEjecuta,
    );
    await expect(service.obtener('r-1', 'dist-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(buscar.mock.calls[0][0]).toMatchObject({
      where: { readingId: 'r-1', distributorId: 'dist-b' },
    });
  });
});

describe('DocumentReadingService: cerrojo', () => {
  it('toma el cerrojo por distribuidora y huella del archivo', async () => {
    const withLock = jest.fn(
      <T>(_k: string, _t: number, fn: () => Promise<T>) =>
        fn().then((valor) => ({ obtenido: true as const, valor })),
    );
    const { service } = armar({});
    Object.assign(service, { redis: { withLock } });
    await service.leerAdjunto(documento);
    expect(withLock.mock.calls[0][0]).toBe(`document-reading:dist-a:${huella}`);
  });

  it('si otro pedido lo tiene ocupado más de la espera, 409 sin llamar al servicio', async () => {
    const { service, leer } = armar({});
    Object.assign(service, {
      redis: { withLock: () => Promise.resolve({ obtenido: false }) },
    });
    await expect(service.leerAdjunto(documento)).rejects.toThrow(
      'se está leyendo',
    );
    expect(leer).not.toHaveBeenCalled();
  });
});

describe('DocumentReadingService.registrarFalloPrevio', () => {
  it('sin lectura previa crea una fallida con huella en ceros, intento 1 y el motivo', async () => {
    const { service, guardar } = armar({});
    const r = await service.registrarFalloPrevio({
      distributorId: 'dist-a',
      attachmentId: 'adj-9',
      motivo: 'El archivo no está en el almacenamiento: subilo de nuevo',
    });
    expect(r).toMatchObject({
      status: DocumentReadingStatus.FAILED,
      attempts: 1,
      fileSha256: '0'.repeat(64),
      lastError: expect.stringContaining('almacenamiento') as string,
    });
    expect(guardar).toHaveBeenCalledTimes(1);
  });

  it('con una fallida previa suma el intento', async () => {
    const { service } = armar({
      existente: {
        status: DocumentReadingStatus.FAILED,
        attempts: 2,
        fileSha256: '0'.repeat(64),
      },
    });
    const r = await service.registrarFalloPrevio({
      distributorId: 'dist-a',
      attachmentId: 'adj-9',
      motivo: 'x',
    });
    expect(r.attempts).toBe(3);
  });

  it('una ya leída no se toca', async () => {
    const { service, guardar } = armar({
      existente: {
        readingId: 'r-1',
        status: DocumentReadingStatus.READ,
        attempts: 1,
      },
    });
    const r = await service.registrarFalloPrevio({
      distributorId: 'dist-a',
      attachmentId: 'adj-9',
      motivo: 'x',
    });
    expect(r.status).toBe(DocumentReadingStatus.READ);
    expect(guardar).not.toHaveBeenCalled();
  });

  it('al leer de verdad un adjunto que había fallado, se guarda la huella real', async () => {
    const { service } = armar({
      existente: {
        status: DocumentReadingStatus.FAILED,
        attempts: 1,
        fileSha256: '0'.repeat(64),
      },
    });
    const { registro } = await service.leerAdjunto(documento);
    expect(registro.fileSha256).toBe(huella);
    expect(registro.status).toBe(DocumentReadingStatus.READ);
  });
});
