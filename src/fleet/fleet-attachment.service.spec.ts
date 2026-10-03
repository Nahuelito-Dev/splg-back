import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { Readable } from 'stream';
import { FleetAttachmentService } from './fleet-attachment.service';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import { FleetTaskService } from './fleet-task.service';
import { StoragePort } from '../storage/ports/storage.port';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';

function archivo(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'poliza.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.4 contenido'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as unknown as Express.Multer.File['stream'],
    ...over,
  };
}

describe('FleetAttachmentService', () => {
  let service: FleetAttachmentService;
  let attachments: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let taskService: { findOne: jest.Mock };
  let cleanup: {
    removeInBackground: jest.Mock;
    reserveUpload: jest.Mock;
    confirmUpload: jest.Mock;
    scheduleRemoval: jest.Mock;
  };
  let storage: {
    put: jest.Mock;
    remove: jest.Mock;
    getSignedDownload: jest.Mock;
    getStream: jest.Mock;
  };

  beforeEach(() => {
    attachments = {
      create: jest.fn((a: Partial<MaintenanceTaskAttachment>) => a),
      save: jest.fn((a: MaintenanceTaskAttachment) => Promise.resolve(a)),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          fn({ save: attachments.save, remove: attachments.remove }),
        ),
      },
    };
    taskService = { findOne: jest.fn().mockResolvedValue({ taskId: 't1' }) };
    cleanup = {
      removeInBackground: jest.fn(),
      reserveUpload: jest.fn().mockResolvedValue(undefined),
      confirmUpload: jest.fn().mockResolvedValue(undefined),
      scheduleRemoval: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      getSignedDownload: jest.fn(),
      getStream: jest.fn(),
    };

    service = new FleetAttachmentService(
      attachments as unknown as Repository<MaintenanceTaskAttachment>,
      taskService as unknown as FleetTaskService,
      storage as unknown as StoragePort,
      cleanup as unknown as StorageCleanupService,
    );
  });

  describe('upload', () => {
    it('sube un PDF válido y guarda el registro', async () => {
      const result = await service.upload('t1', 'd1', archivo(), 'u1');

      expect(taskService.findOne).toHaveBeenCalledWith('t1', 'd1');
      expect(storage.put).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'application/pdf' }),
      );
      expect(result).toMatchObject({
        taskId: 't1',
        distributorId: 'd1',
        originalName: 'poliza.pdf',
        mimeType: 'application/pdf',
        uploadedByUserId: 'u1',
      });
    });

    it('rechaza un tipo de archivo no permitido', async () => {
      await expect(
        service.upload(
          't1',
          'd1',
          archivo({ mimetype: 'application/msword' }),
          'u1',
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rechaza un archivo vacío con 400, sin subir nada', async () => {
      await expect(
        service.upload('t1', 'd1', archivo({ size: 0 }), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
      expect(attachments.save).not.toHaveBeenCalled();
    });

    it('guarda el nombre con las tildes bien (multer lo entrega en latin1)', async () => {
      const comoLlega = Buffer.from('póliza.pdf', 'utf8').toString('latin1');
      const result = await service.upload(
        't1',
        'd1',
        archivo({ originalname: comoLlega }),
        'u1',
      );
      expect(result.originalName).toBe('póliza.pdf');
    });

    it('rechaza un archivo más grande que el máximo', async () => {
      await expect(
        service.upload(
          't1',
          'd1',
          archivo({ size: MAX_ATTACHMENT_SIZE_BYTES + 1 }),
          'u1',
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('una tarea de otra distribuidora es 404, sin subir nada', async () => {
      taskService.findOne.mockRejectedValue(new NotFoundException());
      await expect(
        service.upload('t1', 'd2', archivo(), 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('si falla el guardado en base, borra el archivo ya subido (rollback)', async () => {
      attachments.save.mockRejectedValue(new Error('boom'));
      await expect(
        service.upload('t1', 'd1', archivo(), 'u1'),
      ).rejects.toThrow();
      expect(cleanup.removeInBackground).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDownload', () => {
    it('si el storage da URL firmada, la devuelve para redirigir', async () => {
      attachments.findOne.mockResolvedValue({
        attachmentId: 'a1',
        storageKey: 'k1',
        originalName: 'poliza.pdf',
        mimeType: 'application/pdf',
      });
      storage.getSignedDownload.mockResolvedValue({
        url: 'https://s3/firmada',
        expiresAt: new Date(),
      });

      const result = await service.getDownload('t1', 'a1', 'd1');
      expect(result).toEqual({ kind: 'redirect', url: 'https://s3/firmada' });
    });

    it('sin URL firmada (local), devuelve el stream para servirlo', async () => {
      attachments.findOne.mockResolvedValue({
        attachmentId: 'a1',
        storageKey: 'k1',
        originalName: 'poliza.pdf',
        mimeType: 'application/pdf',
      });
      storage.getSignedDownload.mockResolvedValue(null);
      const stream = Readable.from([Buffer.from('x')]);
      storage.getStream.mockResolvedValue({
        stream,
        contentType: 'application/pdf',
        sizeBytes: 1,
      });

      const result = await service.getDownload('t1', 'a1', 'd1');
      expect(result).toMatchObject({
        kind: 'stream',
        fileName: 'poliza.pdf',
        mimeType: 'application/pdf',
      });
    });

    it('un adjunto que no existe es 404', async () => {
      attachments.findOne.mockResolvedValue(null);
      await expect(
        service.getDownload('t1', 'a1', 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('borra el registro y el archivo del storage', async () => {
      attachments.findOne.mockResolvedValue({
        attachmentId: 'a1',
        storageKey: 'k1',
      });
      await service.remove('t1', 'a1', 'd1');
      expect(attachments.remove).toHaveBeenCalled();
      expect(cleanup.removeInBackground).toHaveBeenCalledWith('k1');
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });
});
