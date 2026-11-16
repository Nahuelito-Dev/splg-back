import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Attachment, AttachmentOwnerType } from './entities/attachment.entity';
import { AttachmentOwnerRegistry } from './attachment-owner.registry';
import { AttachmentOwnerResolver } from './ports/attachment-owner-resolver.port';
import { S3Service, SignedDownload } from '../s3/s3.service';
import { S3CleanupService } from '../s3/s3-cleanup.service';
import {
  acotarNombreDeArchivo,
  decodificarNombreDeArchivo,
  esDocumentoPermitido,
  extensionParaMimeType,
  firmaCoincideConMimeType,
  esMimeTypePermitido,
  MAX_ATTACHMENT_SIZE_BYTES,
  normalizarMimeDeCsv,
} from '../common/utils/attachment-rules';
import { limpiarMetadatosDeImagen } from '../s3/limpiar-imagen';
import { RoleType } from '../common/constants/role-type.enum';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import type { Disposicion } from '../s3/content-disposition';
import { valorLegible } from '../common/validation/etiquetas';

/** Quién pide: el rol decide si hace falta que el dueño sea "propio". */
export interface AttachmentActor {
  userId: string;
  role: RoleType;
}

/** Los únicos tipos que un chofer puede tocar, y sólo si el dueño es suyo. */
export const OWNER_TYPES_DEL_CHOFER: readonly AttachmentOwnerType[] = [
  AttachmentOwnerType.FUEL_LOAD,
  AttachmentOwnerType.VEHICLE_ACCIDENT,
  AttachmentOwnerType.DRIVER_SETTLEMENT,
];

/**
 * Dueños cuyos adjuntos entran y salen sólo por el endpoint de su módulo (con sus
 * reglas: tipo de archivo, estado del dueño, escaneo): el endpoint genérico
 * `/attachments` no los sube ni los da de baja.
 */
export const OWNER_TYPES_SOLO_POR_SU_ENDPOINT: readonly AttachmentOwnerType[] =
  [
    AttachmentOwnerType.INSURANCE_INSTALLMENT,
    AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
    AttachmentOwnerType.MP_RECONCILIATION,
    AttachmentOwnerType.CAR_DOCUMENT,
  ];

/** El endpoint de cada uno de esos dueños, para el mensaje de 400. */
const ENDPOINT_DEL_DUENO: Readonly<
  Partial<Record<AttachmentOwnerType, string>>
> = {
  [AttachmentOwnerType.INSURANCE_INSTALLMENT]:
    'POST /insurance-installments/:id/receipt',
  [AttachmentOwnerType.TRAFFIC_FINE_PAYMENT]: 'POST /traffic-fines/:id/receipt',
  [AttachmentOwnerType.MP_RECONCILIATION]:
    'POST /api/v2/mercadopago/reconciliations',
  [AttachmentOwnerType.CAR_DOCUMENT]: 'POST /api/v2/cars/:id/documents',
};

/** Mensaje de 400 del endpoint genérico para esos dueños. */
export function mensajeSoloPorSuEndpoint(
  ownerType: AttachmentOwnerType,
): string {
  return `Los adjuntos de «${valorLegible(ownerType, 'ownerType')}» se cargan y se dan de baja desde su propia sección (${ENDPOINT_DEL_DUENO[ownerType] ?? 'la de su módulo'})`;
}

/**
 * Dueños cuyos adjuntos se listan y se bajan sólo por el endpoint de su módulo,
 * con el permiso de ese módulo (los documentos del vehículo piden `flota.ver`):
 * los GET genéricos de `/attachments` (que piden `catalogo.ver`) no los muestran.
 */
export const OWNER_TYPES_LECTURA_POR_SU_ENDPOINT: readonly AttachmentOwnerType[] =
  [AttachmentOwnerType.CAR_DOCUMENT];

/** Dónde se ven los adjuntos de esos dueños, para el mensaje de 400. */
const ENDPOINT_DE_LECTURA_DEL_DUENO: Readonly<
  Partial<Record<AttachmentOwnerType, string>>
> = {
  [AttachmentOwnerType.CAR_DOCUMENT]: 'GET /api/v2/cars/:id/documents',
};

/** Mensaje de 400 de los GET genéricos para esos dueños. */
export function mensajeLecturaPorSuEndpoint(
  ownerType: AttachmentOwnerType,
): string {
  return `Los adjuntos de «${valorLegible(ownerType, 'ownerType')}» se ven y se bajan desde su propia sección (${ENDPOINT_DE_LECTURA_DEL_DUENO[ownerType] ?? 'la de su módulo'})`;
}

/** El dueño del que tiene que ser un adjunto pedido desde el endpoint de su módulo. */
export interface DuenoDelAdjunto {
  ownerType: AttachmentOwnerType;
  ownerId: string;
}

/** Trabajo extra que corre en la MISMA transacción que guarda el adjunto. */
export interface AttachmentUploadHooks {
  dentro?: (manager: EntityManager, attachment: Attachment) => Promise<void>;
}

/**
 * Adjuntos genéricos de los módulos de empresa. Habla con `S3Service` y
 * delega en el resolver de cada módulo dueño la pregunta "¿existe este dueño
 * y es de esta distribuidora?".
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  constructor(
    @InjectRepository(Attachment)
    private readonly attachments: Repository<Attachment>,
    private readonly registry: AttachmentOwnerRegistry,
    private readonly storage: S3Service,
    private readonly cleanup: S3CleanupService,
  ) {}

  async upload(
    ownerType: AttachmentOwnerType,
    ownerId: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
    label: string | undefined,
    actor: AttachmentActor,
    hooks: AttachmentUploadHooks = {},
  ): Promise<Attachment> {
    await this.assertAcceso(ownerType, ownerId, distributorId, actor);

    if (!file) {
      throw new BadRequestException('Falta el archivo');
    }
    if (file.size === 0) {
      throw new BadRequestException('El archivo está vacío');
    }
    const nombre = decodificarNombreDeArchivo(file.originalname);
    const mimeType = normalizarMimeDeCsv(file.mimetype, nombre);
    if (!esDocumentoPermitido(mimeType)) {
      throw new UnsupportedMediaTypeException(
        `Tipo de archivo no permitido (${file.mimetype}). Se acepta PDF, JPG, PNG, WEBP, Word (.docx), Excel (.xlsx) o CSV`,
      );
    }
    // Un chofer sólo sube fotos y PDF (comprobantes de su trabajo).
    if (actor.role === RoleType.DELIVERY && !esMimeTypePermitido(mimeType)) {
      throw new UnsupportedMediaTypeException(
        `Tipo de archivo no permitido (${file.mimetype}). Se acepta PDF, JPG, PNG o WEBP`,
      );
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new PayloadTooLargeException(
        `El archivo supera el máximo permitido (${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB)`,
      );
    }
    if (!firmaCoincideConMimeType(mimeType, file.buffer)) {
      throw new UnsupportedMediaTypeException(
        `El contenido del archivo no coincide con el tipo declarado (${file.mimetype})`,
      );
    }

    const cuerpo = await limpiarMetadatosDeImagen(file.buffer, mimeType);
    const key = `attachments/${distributorId}/${ownerType}/${ownerId}/${randomUUID()}.${extensionParaMimeType(mimeType)}`;
    // Se anota la key antes de subir: si el proceso cae antes de guardar la
    // referencia, el cron borra el objeto abandonado.
    await this.cleanup.reserveUpload(key);
    await this.storage.put({
      key,
      body: cuerpo,
      contentType: mimeType,
    });

    const attachment = this.attachments.create({
      distributorId,
      ownerType,
      ownerId,
      label: label?.trim() || null,
      storageKey: key,
      originalName: acotarNombreDeArchivo(nombre),
      mimeType,
      sizeBytes: cuerpo.length,
      uploadedByUserId: actor.userId,
    });

    try {
      return await this.attachments.manager.transaction(async (manager) => {
        const saved = await manager.save(attachment);
        await hooks.dentro?.(manager, saved);
        await this.cleanup.confirmUpload(manager, key);
        return saved;
      });
    } catch (error) {
      // El archivo ya se subió: si el registro en la base falla, no queda
      // huérfano en el bucket.
      this.cleanup.removeInBackground(key);
      return traducirErrorDeBase(error, this.logger, 'adjuntos');
    }
  }

  /**
   * El adjunto `attachmentId` si es de ese dueño y de esa distribuidora (y no
   * está dado de baja); `null` si no. Va con el `manager` de quien lo usa para
   * validarlo dentro de su transacción.
   */
  findDelDueno(
    manager: EntityManager,
    attachmentId: string,
    ownerType: AttachmentOwnerType,
    ownerId: string,
    distributorId: string,
  ): Promise<Attachment | null> {
    return manager.findOne(Attachment, {
      where: { attachmentId, ownerType, ownerId, distributorId },
    });
  }

  /**
   * `desdeSuEndpoint`: lo pide el endpoint propio del módulo dueño (con su
   * permiso); si no, los dueños de `OWNER_TYPES_LECTURA_POR_SU_ENDPOINT` son 400.
   */
  async list(
    ownerType: AttachmentOwnerType,
    ownerId: string,
    distributorId: string,
    actor: AttachmentActor,
    desdeSuEndpoint = false,
  ): Promise<Attachment[]> {
    if (
      !desdeSuEndpoint &&
      OWNER_TYPES_LECTURA_POR_SU_ENDPOINT.includes(ownerType)
    ) {
      throw new BadRequestException(mensajeLecturaPorSuEndpoint(ownerType));
    }
    await this.assertAcceso(ownerType, ownerId, distributorId, actor);
    return this.attachments.find({
      where: { distributorId, ownerType, ownerId },
      order: { uploadedAt: 'DESC' },
    });
  }

  async getDownload(
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
    disposition?: Disposicion,
    dueno?: DuenoDelAdjunto,
  ): Promise<string> {
    const attachment = await this.findParaLeer(
      attachmentId,
      distributorId,
      actor,
      dueno,
    );

    const signed = await this.storage.getSignedDownload(attachment.storageKey, {
      fileName: attachment.originalName,
      disposition,
      contentType: attachment.mimeType,
    });
    return signed.url;
  }

  /**
   * URL firmada del adjunto. Con `dueno` (lo pide el endpoint del módulo) el
   * adjunto tiene que ser de ese dueño, si no es 404.
   */
  async getSignedDownload(
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
    disposition?: Disposicion,
    dueno?: DuenoDelAdjunto,
  ): Promise<SignedDownload> {
    const attachment = await this.findParaLeer(
      attachmentId,
      distributorId,
      actor,
      dueno,
    );
    return this.storage.getSignedDownload(attachment.storageKey, {
      fileName: attachment.originalName,
      disposition,
      contentType: attachment.mimeType,
    });
  }

  async remove(
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<void> {
    const attachment = await this.findOneOrThrow(
      attachmentId,
      distributorId,
      actor,
    );
    if (OWNER_TYPES_SOLO_POR_SU_ENDPOINT.includes(attachment.ownerType)) {
      throw new BadRequestException(
        mensajeSoloPorSuEndpoint(attachment.ownerType),
      );
    }
    // El chofer sólo borra lo que subió él, aunque el dueño sea suyo.
    if (
      actor.role === RoleType.DELIVERY &&
      attachment.uploadedByUserId !== actor.userId
    ) {
      throw new NotFoundException('Adjunto no encontrado');
    }
    // Baja lógica: el archivo queda en el storage como respaldo.
    await this.attachments.softRemove(attachment);
  }

  /**
   * Baja lógica desde el endpoint del módulo dueño (los dueños de
   * `OWNER_TYPES_SOLO_POR_SU_ENDPOINT`): 404 si el adjunto no es de ese dueño
   * o de esa distribuidora. El archivo queda en el storage como respaldo.
   */
  async removeDelDueno(
    attachmentId: string,
    dueno: DuenoDelAdjunto,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<void> {
    const attachment = await this.findOneOrThrow(
      attachmentId,
      distributorId,
      actor,
      dueno,
    );
    await this.attachments.softRemove(attachment);
  }

  /** Para ver o bajar: sin `dueno`, los que se leen por su endpoint son 400. */
  private async findParaLeer(
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
    dueno?: DuenoDelAdjunto,
  ): Promise<Attachment> {
    const attachment = await this.findOneOrThrow(
      attachmentId,
      distributorId,
      actor,
      dueno,
    );
    if (
      !dueno &&
      OWNER_TYPES_LECTURA_POR_SU_ENDPOINT.includes(attachment.ownerType)
    ) {
      throw new BadRequestException(
        mensajeLecturaPorSuEndpoint(attachment.ownerType),
      );
    }
    return attachment;
  }

  private async findOneOrThrow(
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
    dueno?: DuenoDelAdjunto,
  ): Promise<Attachment> {
    const attachment = await this.attachments.findOne({
      where: dueno
        ? {
            attachmentId,
            distributorId,
            ownerType: dueno.ownerType,
            ownerId: dueno.ownerId,
          }
        : { attachmentId, distributorId },
    });
    if (!attachment) {
      throw new NotFoundException('Adjunto no encontrado');
    }
    // Con el dueño borrado el adjunto no puede quedar inaccesible: acá alcanza
    // con que la fila sea de la distribuidora. El resolver se exige al subir
    // y al listar.
    await this.assertAcceso(
      attachment.ownerType,
      attachment.ownerId,
      distributorId,
      actor,
      false,
    );
    return attachment;
  }

  /**
   * 400 si ningún módulo registró el tipo; 404 si el dueño no existe o es de
   * otra distribuidora (lo dice el resolver). Un chofer, además, sólo entra a
   * los tipos que le tocan y a dueños propios.
   */
  private async assertAcceso(
    ownerType: AttachmentOwnerType,
    ownerId: string,
    distributorId: string,
    actor: AttachmentActor,
    verificarDueno = true,
  ): Promise<void> {
    if (!verificarDueno && actor.role !== RoleType.DELIVERY) return;
    const resolver = this.resolverDe(ownerType);

    if (
      actor.role === RoleType.DELIVERY &&
      !OWNER_TYPES_DEL_CHOFER.includes(ownerType)
    ) {
      throw new ForbiddenException(
        `Un chofer no puede acceder a adjuntos de «${valorLegible(ownerType, 'ownerType')}»`,
      );
    }

    if (verificarDueno) await resolver.assertOwner(ownerId, distributorId);

    if (actor.role === RoleType.DELIVERY) {
      const esPropio =
        (await resolver.isOwnedByUser?.(
          ownerId,
          actor.userId,
          distributorId,
        )) ?? false;
      if (!esPropio) {
        throw new NotFoundException(
          `No se encontró «${valorLegible(ownerType, 'ownerType')}»`,
        );
      }
    }
  }

  private resolverDe(ownerType: AttachmentOwnerType): AttachmentOwnerResolver {
    const resolver = this.registry.find(ownerType);
    if (!resolver) {
      throw new BadRequestException(
        `Todavía no se pueden adjuntar archivos a «${valorLegible(ownerType)}»`,
      );
    }
    return resolver;
  }
}
