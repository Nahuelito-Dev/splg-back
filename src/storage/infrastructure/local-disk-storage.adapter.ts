import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'path';
import {
  StorageObjectInput,
  StorageObjectStream,
  StoragePort,
} from '../ports/storage.port';

/** Sidecar con la metadata que el filesystem no guarda (el content-type original). */
interface Meta {
  contentType: string;
}

/**
 * Adapter del `StoragePort` sobre el disco local. Activo por defecto
 * (`STORAGE_DRIVER=local`, o sin la variable): pensado para desarrollo y para
 * distribuidoras chicas antes de migrar a `S3StorageAdapter`.
 *
 * Los archivos quedan en `STORAGE_LOCAL_PATH` (fuera de `src`, ignorada por
 * git). No hay URL pública: `getDownloadUrl` devuelve `null` siempre, y el
 * caller sirve el archivo con `getStream` a través de un endpoint propio
 * (con la autenticación de este backend, no de un bucket).
 */
@Injectable()
export class LocalDiskStorageAdapter extends StoragePort {
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    const configured = config.get<string>(
      'STORAGE_LOCAL_PATH',
      './storage-local',
    );
    this.root = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
  }

  async put({ key, body, contentType }: StorageObjectInput): Promise<void> {
    const filePath = this.resolveKey(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    await writeFile(
      this.metaPath(filePath),
      JSON.stringify({ contentType } satisfies Meta),
      'utf-8',
    );
  }

  async remove(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    await rm(filePath, { force: true });
    await rm(this.metaPath(filePath), { force: true });
  }

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async getDownloadUrl(_key: string): Promise<string | null> {
    return null;
  }

  async getStream(key: string): Promise<StorageObjectStream> {
    const filePath = this.resolveKey(key);
    const info = await stat(filePath);
    const contentType = await this.readContentType(filePath);
    return {
      stream: createReadStream(filePath),
      contentType,
      sizeBytes: info.size,
    };
  }

  private async readContentType(filePath: string): Promise<string | null> {
    try {
      const raw = await readFile(this.metaPath(filePath), 'utf-8');
      const meta = JSON.parse(raw) as Meta;
      return meta.contentType;
    } catch {
      return null;
    }
  }

  private metaPath(filePath: string): string {
    return `${filePath}.meta.json`;
  }

  /**
   * La `key` la genera nuestro propio código (nunca el usuario), pero se
   * valida igual: normaliza y exige que el resultado siga bajo `root`, así un
   * `key` con `..` no puede escribir ni leer fuera del storage.
   */
  private resolveKey(key: string): string {
    const filePath = normalize(join(this.root, key));
    if (!filePath.startsWith(normalize(this.root))) {
      throw new InternalServerErrorException(
        'Clave de almacenamiento inválida',
      );
    }
    return filePath;
  }
}
