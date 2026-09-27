import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalDiskStorageAdapter } from './local-disk-storage.adapter';

function leerStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString()));
    stream.on('error', reject);
  });
}

describe('LocalDiskStorageAdapter', () => {
  let root: string;
  let adapter: LocalDiskStorageAdapter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'splg-storage-'));
    const config = {
      get: jest.fn().mockReturnValue(root),
    } as unknown as ConfigService;
    adapter = new LocalDiskStorageAdapter(config);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('guarda y devuelve el mismo contenido y content-type', async () => {
    await adapter.put({
      key: 'fleet/2026/09/doc.pdf',
      body: Buffer.from('contenido de prueba'),
      contentType: 'application/pdf',
    });

    const { stream, contentType, sizeBytes } = await adapter.getStream(
      'fleet/2026/09/doc.pdf',
    );
    const contenido = await leerStream(stream);

    expect(contenido).toBe('contenido de prueba');
    expect(contentType).toBe('application/pdf');
    expect(sizeBytes).toBe(Buffer.byteLength('contenido de prueba'));
  });

  it('no tiene URL de descarga directa: hay que pedir el stream', async () => {
    await expect(adapter.getDownloadUrl('cualquiera')).resolves.toBeNull();
  });

  it('borrar es idempotente: no falla si el archivo no existe', async () => {
    await expect(adapter.remove('no-existe.pdf')).resolves.toBeUndefined();
  });

  it('borra el archivo y su metadata', async () => {
    await adapter.put({
      key: 'doc.pdf',
      body: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    await adapter.remove('doc.pdf');

    await expect(adapter.getStream('doc.pdf')).rejects.toBeDefined();
  });

  it('una clave con .. no puede escapar de la carpeta configurada', async () => {
    await expect(
      adapter.put({
        key: '../fuera-del-storage.pdf',
        body: Buffer.from('x'),
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
