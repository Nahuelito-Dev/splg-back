import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { S3Service, SignedDownload } from './s3.service';
import { MAX_FOTO_BYTES } from './upload-limits';
import { S3CleanupService } from './s3-cleanup.service';
import { errorMessage } from '../common/errors/error-message';
import { limpiarMetadatosDeImagen } from './limpiar-imagen';
import {
  esImagenPermitida,
  extensionParaMimeType,
  firmaCoincideConMimeType,
} from '../common/utils/attachment-rules';

export { MAX_FOTO_BYTES };
/**
 * Dónde vive la foto de una entidad: la entidad, la propiedad de su
 * identificador y la propiedad que guarda la key del objeto en el bucket
 * (`photoKey`, o `logoKey` en la distribuidora).
 */
export interface DestinoDeFoto {
  entity: EntityTarget<ObjectLiteral>;
  idProp: string;
  keyProp: string;
}

/**
 * Las entidades con foto llevan este campo transitorio (no es una columna):
 * lo completa `firmar` para que los mappers, que son síncronos y no conocen
 * S3, devuelvan la URL firmada.
 */
export interface ConFotoFirmada {
  photoSignedUrl?: string | null;
}

/**
 * Control que corre con la fila ya bloqueada: lo que se decide antes del lock
 * puede cambiar en el medio. Lanza para cancelar el cambio.
 */
export type VerificarFila = (fila: Readonly<Record<string, unknown>>) => void;

/** Un archivo que pasó la validación, con su tipo estrechado. */
export interface ImagenValida {
  buffer: Buffer;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
}

/** El enlace a la foto para `?modo=url`. */
export type EnlaceDeFoto =
  | { kind: 'none' }
  | { kind: 'stored'; signed: SignedDownload };

/**
 * Lo común de las fotos de entidades (patrón de la foto del reclamo): validar
 * el archivo por su contenido, subirlo a S3, apuntar la entidad a la key nueva
 * y mandar la anterior a limpieza. Cada módulo decide quién puede y arma la
 * key; esto no sabe de permisos ni de distribuidoras.
 */
@Injectable()
export class EntityPhotoService {
  private readonly logger = new Logger(EntityPhotoService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: S3Service,
    private readonly cleanup: S3CleanupService,
  ) {}

  /**
   * Valida el archivo recibido: presente, no vacío, imagen, hasta 5 MB y
   * firma coherente con el tipo declarado. Devuelve el tipo ya estrechado.
   */
  validar(file: Express.Multer.File | undefined): ImagenValida {
    if (!file) throw new BadRequestException('Falta la foto');
    if (file.size === 0) throw new BadRequestException('La foto está vacía');
    const mime = file.mimetype;
    if (!esImagenPermitida(mime)) {
      throw new UnsupportedMediaTypeException(
        `Tipo de archivo no permitido (${mime}). Se acepta JPG, PNG o WEBP`,
      );
    }
    if (file.size > MAX_FOTO_BYTES) {
      throw new PayloadTooLargeException(
        `La foto supera el máximo permitido (${MAX_FOTO_BYTES / (1024 * 1024)} MB)`,
      );
    }
    if (!firmaCoincideConMimeType(mime, file.buffer)) {
      throw new UnsupportedMediaTypeException(
        `El contenido del archivo no coincide con el tipo declarado (${mime})`,
      );
    }
    return { buffer: file.buffer, mime };
  }

  /**
   * Sube (o reemplaza) la foto. `carpeta` es el prefijo de la key (sin barra
   * final). La entidad ya tiene que haber pasado el control de tenant en quien
   * llama. La foto anterior queda anotada para borrar en la misma transacción
   * que cambia la referencia.
   */
  async guardar(
    destino: DestinoDeFoto,
    id: string,
    file: Express.Multer.File | undefined,
    carpeta: string,
    verificar?: VerificarFila,
  ): Promise<void> {
    const imagen = this.validar(file);
    const cuerpo = await limpiarMetadatosDeImagen(imagen.buffer, imagen.mime);
    const key = `${carpeta}/${randomUUID()}.${extensionParaMimeType(imagen.mime)}`;
    // Se anota la key antes de subir: si el proceso cae antes de que la entidad
    // apunte a la foto, el cron borra el objeto abandonado.
    await this.cleanup.reserveUpload(key);
    await this.storage.put({
      key,
      body: cuerpo,
      contentType: imagen.mime,
    });
    try {
      const anterior = await this.cambiarClave(destino, id, key, verificar);
      if (anterior) this.cleanup.removeInBackground(anterior);
    } catch (error) {
      // El archivo ya se subió pero la entidad no apunta a él: se borra.
      this.cleanup.removeInBackground(key);
      throw error;
    }
  }

  /** Saca la foto: la referencia queda en null y el objeto va a limpieza. */
  async quitar(
    destino: DestinoDeFoto,
    id: string,
    verificar?: VerificarFila,
  ): Promise<void> {
    const anterior = await this.cambiarClave(destino, id, null, verificar);
    if (anterior) this.cleanup.removeInBackground(anterior);
  }

  /**
   * Lee la key vigente con lock, la reemplaza y anota la anterior para borrar,
   * todo en una transacción. Devuelve la key anterior.
   */
  private cambiarClave(
    destino: DestinoDeFoto,
    id: string,
    nueva: string | null,
    verificar?: VerificarFila,
  ): Promise<string | null> {
    return this.dataSource.manager.transaction(async (manager) => {
      const fila = await manager
        .createQueryBuilder(destino.entity, 'e')
        .setLock('pessimistic_write')
        .where(`e.${destino.idProp} = :id`, { id })
        .getOne();
      if (!fila) throw new NotFoundException('No encontrado');
      const registro = fila as Record<string, unknown>;
      verificar?.(registro);
      const actual = registro[destino.keyProp];
      const anterior = typeof actual === 'string' ? actual : null;
      registro[destino.keyProp] = nueva;
      await manager.save(fila);
      if (anterior) await this.cleanup.scheduleRemoval(manager, anterior);
      if (nueva) await this.cleanup.confirmUpload(manager, nueva);
      return anterior;
    });
  }

  /**
   * URL firmada para el campo de la foto. Nunca rompe la respuesta: sin foto o
   * si falla la firma, es `null`.
   */
  async urlDe(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    try {
      return (await this.storage.getSignedDownload(key)).url;
    } catch (error) {
      this.logger.warn(`No se pudo firmar ${key}: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * El enlace firmado con su vencimiento, sin romper nunca: sin foto o si la
   * firma falla, es `null`. Para firmar muchas fotos en un pedido.
   */
  async firmadaDe(
    key: string | null | undefined,
  ): Promise<SignedDownload | null> {
    if (!key) return null;
    try {
      return await this.storage.getSignedDownload(key);
    } catch (error) {
      this.logger.warn(`No se pudo firmar ${key}: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Completa `photoSignedUrl` en cada entidad (firmar es local y barato). */
  async firmar<T extends ConFotoFirmada>(
    items: T | readonly T[] | null | undefined,
    claveDe: (item: T) => string | null | undefined,
  ): Promise<void> {
    if (!items) return;
    const lista: readonly T[] = Array.isArray(items)
      ? (items as readonly T[])
      : [items as T];
    await Promise.all(
      lista.map(async (item) => {
        item.photoSignedUrl = await this.urlDe(claveDe(item));
      }),
    );
  }

  /** El enlace para `?modo=url` o el redirect: la foto firmada, o nada. */
  async enlace(key: string | null | undefined): Promise<EnlaceDeFoto> {
    if (!key) return { kind: 'none' };
    return {
      kind: 'stored',
      signed: await this.storage.getSignedDownload(key),
    };
  }
}
