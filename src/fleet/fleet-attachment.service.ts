import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import { FleetTaskService } from './fleet-task.service';
import { S3Service, SignedDownload } from '../s3/s3.service';
import { S3CleanupService } from '../s3/s3-cleanup.service';
import {
  acotarNombreDeArchivo,
  decodificarNombreDeArchivo,
  esMimeTypePermitido,
  extensionParaMimeType,
  firmaCoincideConMimeType,
  MAX_ATTACHMENT_SIZE_BYTES,
} from '../common/utils/attachment-rules';
import { limpiarMetadatosDeImagen } from '../s3/limpiar-imagen';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import type { Disposicion } from '../s3/content-disposition';

/**
 * Adjuntos de una tarea de flota: la foto o el PDF de la póliza, la VTV o la
 * licencia (CU-136 a CU-139). Guarda y sirve los archivos a través de
 * `S3Service`.
 */
@Injectable()
export class FleetAttachmentService {
  private readonly logger = new Logger(FleetAttachmentService.name);

  constructor(
    @InjectRepository(MaintenanceTaskAttachment)
    private readonly attachments: Repository<MaintenanceTaskAttachment>,
    private readonly taskService: FleetTaskService,
    private readonly storage: S3Service,
    private readonly cleanup: S3CleanupService,
  ) {}

  async upload(
    taskId: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
    uploadedByUserId: string,
  ): Promise<MaintenanceTaskAttachment> {
    await this.taskService.findOne(taskId, distributorId); // 404 si la tarea no existe/no es de esta distribuidora

    if (!file) {
      throw new BadRequestException('Falta el archivo');
    }
    if (file.size === 0) {
      throw new BadRequestException('El archivo está vacío');
    }
    if (!esMimeTypePermitido(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Tipo de archivo no permitido (${file.mimetype}). Se acepta PDF, JPG, PNG o WEBP`,
      );
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new PayloadTooLargeException(
        `El archivo supera el máximo permitido (${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB)`,
      );
    }
    if (!firmaCoincideConMimeType(file.mimetype, file.buffer)) {
      throw new UnsupportedMediaTypeException(
        `El contenido del archivo no coincide con el tipo declarado (${file.mimetype})`,
      );
    }

    const cuerpo = await limpiarMetadatosDeImagen(file.buffer, file.mimetype);
    const key = `fleet/${distributorId}/${taskId}/${randomUUID()}.${extensionParaMimeType(file.mimetype)}`;
    // Se anota la key antes de subir: si el proceso cae antes de guardar la
    // referencia, el cron borra el objeto abandonado.
    await this.cleanup.reserveUpload(key);
    await this.storage.put({
      key,
      body: cuerpo,
      contentType: file.mimetype,
    });

    const attachment = this.attachments.create({
      taskId,
      distributorId,
      storageKey: key,
      originalName: acotarNombreDeArchivo(
        decodificarNombreDeArchivo(file.originalname),
      ),
      mimeType: file.mimetype,
      sizeBytes: cuerpo.length,
      uploadedByUserId,
    });

    try {
      return await this.attachments.manager.transaction(async (manager) => {
        const saved = await manager.save(attachment);
        await this.cleanup.confirmUpload(manager, key);
        return saved;
      });
    } catch (error) {
      // El archivo ya se subió: si el registro en la base falla, no queda
      // huérfano en el bucket.
      this.cleanup.removeInBackground(key);
      return traducirErrorDeBase(error, this.logger, 'adjuntos de flota');
    }
  }

  async list(
    taskId: string,
    distributorId: string,
  ): Promise<MaintenanceTaskAttachment[]> {
    await this.taskService.findOne(taskId, distributorId);
    return this.attachments.find({
      where: { taskId, distributorId },
      order: { uploadedAt: 'DESC' },
    });
  }

  async getDownload(
    taskId: string,
    attachmentId: string,
    distributorId: string,
    disposition?: Disposicion,
  ): Promise<string> {
    const attachment = await this.findOneOrThrow(
      taskId,
      attachmentId,
      distributorId,
    );

    const signed = await this.storage.getSignedDownload(attachment.storageKey, {
      fileName: attachment.originalName,
      disposition,
      contentType: attachment.mimeType,
    });
    return signed.url;
  }

  /** URL firmada del adjunto. */
  async getSignedDownload(
    taskId: string,
    attachmentId: string,
    distributorId: string,
    disposition?: Disposicion,
  ): Promise<SignedDownload> {
    const attachment = await this.findOneOrThrow(
      taskId,
      attachmentId,
      distributorId,
    );
    return this.storage.getSignedDownload(attachment.storageKey, {
      fileName: attachment.originalName,
      disposition,
      contentType: attachment.mimeType,
    });
  }

  async remove(
    taskId: string,
    attachmentId: string,
    distributorId: string,
  ): Promise<void> {
    const attachment = await this.findOneOrThrow(
      taskId,
      attachmentId,
      distributorId,
    );
    // Baja lógica: el archivo queda en el storage como respaldo.
    await this.attachments.softRemove(attachment);
  }

  private async findOneOrThrow(
    taskId: string,
    attachmentId: string,
    distributorId: string,
  ): Promise<MaintenanceTaskAttachment> {
    await this.taskService.findOne(taskId, distributorId);
    const attachment = await this.attachments.findOne({
      where: { attachmentId, taskId, distributorId },
    });
    if (!attachment) {
      throw new NotFoundException('Adjunto no encontrado');
    }
    return attachment;
  }
}
