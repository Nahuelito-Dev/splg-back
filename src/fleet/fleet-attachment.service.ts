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
import {
  StoragePort,
  StorageObjectStream,
} from '../storage/ports/storage.port';
import {
  esMimeTypePermitido,
  extensionParaMimeType,
  MAX_ATTACHMENT_SIZE_BYTES,
} from './domain/attachment-rules';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';

/** Lo que el controller necesita para responder la descarga, sea cual sea el driver activo. */
export type FleetAttachmentDownload =
  | { kind: 'redirect'; url: string }
  | ({
      kind: 'stream';
      fileName: string;
      mimeType: string;
    } & StorageObjectStream);

/**
 * Adjuntos de una tarea de flota: la foto o el PDF de la póliza, la VTV o la
 * licencia (CU-136 a CU-139). Habla con `StoragePort`, nunca con `fs` ni el
 * SDK de S3 directo: no le importa cuál de los dos está activo.
 */
@Injectable()
export class FleetAttachmentService {
  private readonly logger = new Logger(FleetAttachmentService.name);

  constructor(
    @InjectRepository(MaintenanceTaskAttachment)
    private readonly attachments: Repository<MaintenanceTaskAttachment>,
    private readonly taskService: FleetTaskService,
    private readonly storage: StoragePort,
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

    const key = `fleet/${distributorId}/${taskId}/${randomUUID()}.${extensionParaMimeType(file.mimetype)}`;
    await this.storage.put({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });

    const attachment = this.attachments.create({
      taskId,
      distributorId,
      storageKey: key,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      uploadedByUserId,
    });

    try {
      return await this.attachments.save(attachment);
    } catch (error) {
      // El archivo ya se subió: si el registro en la base falla, no queda
      // huérfano en el storage.
      await this.storage.remove(key);
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
  ): Promise<FleetAttachmentDownload> {
    const attachment = await this.findOneOrThrow(
      taskId,
      attachmentId,
      distributorId,
    );

    const redirectUrl = await this.storage.getDownloadUrl(
      attachment.storageKey,
    );
    if (redirectUrl) {
      return { kind: 'redirect', url: redirectUrl };
    }

    const stream = await this.storage.getStream(attachment.storageKey);
    return {
      kind: 'stream',
      fileName: attachment.originalName,
      mimeType: stream.contentType ?? attachment.mimeType,
      ...stream,
    };
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
    await this.attachments.remove(attachment);
    await this.storage.remove(attachment.storageKey);
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
      throw new NotFoundException(`Adjunto ${attachmentId} no encontrado`);
    }
    return attachment;
  }
}
