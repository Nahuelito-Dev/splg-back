import type { Readable } from 'stream';

/** Lo que hace falta para guardar un archivo, sin importar el driver. */
export interface StorageObjectInput {
  /** Clave única dentro del storage (incluye "carpeta": p. ej. `fleet/2026/09/uuid.pdf`). */
  key: string;
  body: Buffer;
  contentType: string;
}

/** Un archivo leído del storage, para servirlo con `stream.pipe(res)`. */
export interface StorageObjectStream {
  stream: Readable;
  contentType: string | null;
  /** En bytes, si el driver lo sabe (Local y S3 lo saben). */
  sizeBytes: number | null;
}

/**
 * PUERTO de almacenamiento de archivos. Los servicios que guardan adjuntos
 * (hoy sólo `fleet`, mañana cualquiera) hablan con ESTA interfaz, nunca con
 * `fs` ni con el SDK de AWS directo. `LocalDiskStorageAdapter` y
 * `S3StorageAdapter` (infrastructure) implementan el cómo.
 *
 * El driver se elige por `STORAGE_DRIVER` (`local` | `s3`, ver
 * `storage.module.ts`): el resto del código no sabe cuál está activo.
 */
export abstract class StoragePort {
  /** Sube (o sobreescribe) el objeto en `input.key`. */
  abstract put(input: StorageObjectInput): Promise<void>;

  /** Borra el objeto. No falla si ya no existe (idempotente). */
  abstract remove(key: string): Promise<void>;

  /**
   * URL para descargar el archivo directo desde el proveedor (p. ej. una URL
   * firmada de S3, con expiración corta), sin pasar por este backend.
   * `null` si el driver no soporta esto (el caso de `local`): ahí el caller
   * tiene que usar `getStream` y servir el archivo él mismo. Con `fileName`,
   * la URL fuerza la descarga con ese nombre (`Content-Disposition`).
   */
  abstract getDownloadUrl(
    key: string,
    options?: { fileName?: string },
  ): Promise<string | null>;

  /** Lee el objeto para servirlo por streaming a través de este backend. */
  abstract getStream(key: string): Promise<StorageObjectStream>;
}
