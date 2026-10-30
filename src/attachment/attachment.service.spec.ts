import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { AttachmentActor, AttachmentService } from './attachment.service';
import { Attachment, AttachmentOwnerType } from './entities/attachment.entity';
import { AttachmentOwnerRegistry } from './attachment-owner.registry';
import { AttachmentOwnerResolver } from './ports/attachment-owner-resolver.port';
import { S3Service } from '../s3/s3.service';
import { S3CleanupService } from '../s3/s3-cleanup.service';
import {
  CSV_MIME_TYPE,
  DOCX_MIME_TYPE,
  MAX_ATTACHMENT_SIZE_BYTES,
  XLSX_MIME_TYPE,
} from '../common/utils/attachment-rules';
import { zipDePrueba } from '../common/utils/zip-de-prueba';
import { RoleType } from '../common/constants/role-type.enum';
import { imagenesDePrueba, tieneExif } from '../s3/imagenes-de-prueba';

function archivo(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'dni.pdf',
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

const ADMIN: AttachmentActor = { userId: 'u-admin', role: RoleType.ADMIN };
const CHOFER: AttachmentActor = { userId: 'u-chofer', role: RoleType.DELIVERY };

describe('AttachmentService', () => {
  let service: AttachmentService;
  let attachments: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    softRemove: jest.Mock;
    manager: { transaction: jest.Mock };
  };
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
  };
  let resolverEmpleado: {
    ownerType: AttachmentOwnerType;
    assertOwner: jest.Mock;
  };
  let resolverCarga: {
    ownerType: AttachmentOwnerType;
    assertOwner: jest.Mock;
    isOwnedByUser: jest.Mock;
  };

  beforeEach(() => {
    attachments = {
      create: jest.fn((a: Partial<Attachment>) => a),
      save: jest.fn((a: Attachment) => Promise.resolve(a)),
      find: jest.fn(),
      findOne: jest.fn(),
      softRemove: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          fn({ save: attachments.save }),
        ),
      },
    };
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
    };
    resolverEmpleado = {
      ownerType: AttachmentOwnerType.EMPLOYEE,
      assertOwner: jest.fn().mockResolvedValue(undefined),
    };
    resolverCarga = {
      ownerType: AttachmentOwnerType.FUEL_LOAD,
      assertOwner: jest.fn().mockResolvedValue(undefined),
      isOwnedByUser: jest.fn().mockResolvedValue(true),
    };
    const registry = new AttachmentOwnerRegistry();
    registry.register(resolverEmpleado as AttachmentOwnerResolver);
    registry.register(resolverCarga as AttachmentOwnerResolver);

    service = new AttachmentService(
      attachments as unknown as Repository<Attachment>,
      registry,
      storage as unknown as S3Service,
      cleanup as unknown as S3CleanupService,
    );
  });

  describe('findDelDueno', () => {
    it('busca el adjunto por dueño y distribuidora con el manager de quien lo pide', async () => {
      const adjunto = { attachmentId: 'a1' };
      const manager = { findOne: jest.fn().mockResolvedValue(adjunto) };

      const r = await service.findDelDueno(
        manager as unknown as EntityManager,
        'a1',
        AttachmentOwnerType.INSURANCE_INSTALLMENT,
        'q1',
        'd1',
      );

      expect(r).toBe(adjunto);
      expect(manager.findOne).toHaveBeenCalledWith(Attachment, {
        where: {
          attachmentId: 'a1',
          ownerType: AttachmentOwnerType.INSURANCE_INSTALLMENT,
          ownerId: 'q1',
          distributorId: 'd1',
        },
      });
    });
  });

  describe('upload', () => {
    it('valida el dueño con su resolver, sube el archivo y guarda el registro', async () => {
      const result = await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo(),
        ' DNI frente ',
        ADMIN,
      );

      expect(resolverEmpleado.assertOwner).toHaveBeenCalledWith('e1', 'd1');
      expect(storage.put).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'application/pdf',
          key: expect.stringMatching(
            /^attachments\/d1\/employee\/e1\/[0-9a-f-]{36}\.pdf$/,
          ) as string,
        }),
      );
      expect(result).toMatchObject({
        distributorId: 'd1',
        ownerType: 'employee',
        ownerId: 'e1',
        label: 'DNI frente',
        originalName: 'dni.pdf',
        uploadedByUserId: 'u-admin',
      });
    });

    it('una foto con GPS se sube sin EXIF y el registro guarda el tamaño real', async () => {
      const foto = await imagenesDePrueba.jpeg(true);
      expect(await tieneExif(foto)).toBe(true);
      const result = await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo({ mimetype: 'image/jpeg', buffer: foto, size: foto.length }),
        undefined,
        ADMIN,
      );
      const [subido] = storage.put.mock.calls[0] as [{ body: Buffer }];
      expect(await tieneExif(subido.body)).toBe(false);
      expect(result.sizeBytes).toBe(subido.body.length);
    });

    it('un PDF se sube sin tocarse', async () => {
      const pdf = Buffer.from('%PDF-1.4 contenido');
      await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo({ buffer: pdf, size: pdf.length }),
        undefined,
        ADMIN,
      );
      const [subido] = storage.put.mock.calls[0] as [{ body: Buffer }];
      expect(subido.body).toBe(pdf);
    });

    it('un tipo sin resolver registrado es 400, no 500, y no sube nada', async () => {
      await expect(
        service.upload(
          AttachmentOwnerType.TRAFFIC_FINE,
          't1',
          'd1',
          archivo(),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('si el resolver dice 404 (dueño ajeno o inexistente) no sube nada', async () => {
      resolverEmpleado.assertOwner.mockRejectedValue(new NotFoundException());
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo(),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it.each([
      ['falta el archivo', undefined, BadRequestException],
      ['archivo vacío', archivo({ size: 0 }), BadRequestException],
      [
        'mime no permitido',
        archivo({ mimetype: 'application/msword' }),
        UnsupportedMediaTypeException,
      ],
      [
        'más de 10 MB',
        archivo({ size: MAX_ATTACHMENT_SIZE_BYTES + 1 }),
        PayloadTooLargeException,
      ],
    ])('rechaza: %s', async (_caso, file, error) => {
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          file,
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(error);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('un HTML declarado como image/png es 415 y no se sube', async () => {
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo({
            mimetype: 'image/png',
            buffer: Buffer.from('<html></html>'),
          }),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('un nombre de más de 255 caracteres se recorta conservando la extensión', async () => {
      const result = await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo({ originalname: `${'n'.repeat(400)}.pdf` }),
        undefined,
        ADMIN,
      );
      expect(result.originalName).toHaveLength(255);
      expect(result.originalName.endsWith('.pdf')).toBe(true);
    });

    it.each([
      [
        'Word',
        DOCX_MIME_TYPE,
        'informe.docx',
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
      ],
      [
        'Excel',
        XLSX_MIME_TYPE,
        'planilla.xlsx',
        zipDePrueba(['[Content_Types].xml', 'xl/workbook.xml']),
      ],
      ['CSV', CSV_MIME_TYPE, 'lista.csv', Buffer.from('a;b\n1;2\n')],
    ])(
      'acepta %s y lo sube sin tocarlo',
      async (_n, mimetype, nombre, buffer) => {
        const result = await service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo({
            mimetype,
            originalname: nombre,
            buffer,
            size: buffer.length,
          }),
          undefined,
          ADMIN,
        );
        const [subido] = storage.put.mock.calls[0] as [
          { body: Buffer; contentType: string; key: string },
        ];
        expect(subido.body).toBe(buffer);
        expect(subido.contentType).toBe(mimetype);
        expect(subido.key.endsWith(`.${nombre.split('.')[1]}`)).toBe(true);
        expect(result.mimeType).toBe(mimetype);
      },
    );

    it.each([
      [DOCX_MIME_TYPE, Buffer.from('MZ-ejecutable')],
      [
        XLSX_MIME_TYPE,
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
      ],
      [CSV_MIME_TYPE, Buffer.from([0x61, 0x00, 0x62])],
    ])(
      '%s con contenido que no es del tipo declarado: 415, sin subir',
      async (mimetype, buffer) => {
        await expect(
          service.upload(
            AttachmentOwnerType.EMPLOYEE,
            'e1',
            'd1',
            archivo({ mimetype, buffer, size: buffer.length }),
            undefined,
            ADMIN,
          ),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(storage.put).not.toHaveBeenCalled();
      },
    );

    it('un CSV de Excel en Windows (vnd.ms-excel, .csv, Windows-1252) se guarda como text/csv', async () => {
      const ansi = Buffer.from('nombre;ciudad\nJosé;Córdoba\n', 'latin1');
      const result = await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo({
          mimetype: 'application/vnd.ms-excel',
          originalname: 'clientes.csv',
          buffer: ansi,
          size: ansi.length,
        }),
        undefined,
        ADMIN,
      );
      expect(result.mimeType).toBe(CSV_MIME_TYPE);
      const [subido] = storage.put.mock.calls[0] as [
        { contentType: string; key: string },
      ];
      expect(subido.contentType).toBe(CSV_MIME_TYPE);
      expect(subido.key.endsWith('.csv')).toBe(true);
    });

    it('vnd.ms-excel sin extensión .csv sigue siendo 415', async () => {
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo({
            mimetype: 'application/vnd.ms-excel',
            originalname: 'planilla.xls',
          }),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it.each([
      [
        'Word',
        DOCX_MIME_TYPE,
        'a.docx',
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
      ],
      [
        'Excel',
        XLSX_MIME_TYPE,
        'a.xlsx',
        zipDePrueba(['[Content_Types].xml', 'xl/workbook.xml']),
      ],
      ['CSV', CSV_MIME_TYPE, 'a.csv', Buffer.from('a;b\n')],
    ])(
      'el chofer no sube %s, ni a su propia carga (415): sólo PDF e imágenes',
      async (_n, mimetype, originalname, buffer) => {
        await expect(
          service.upload(
            AttachmentOwnerType.FUEL_LOAD,
            'c1',
            'd1',
            archivo({ mimetype, originalname, buffer, size: buffer.length }),
            undefined,
            CHOFER,
          ),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(storage.put).not.toHaveBeenCalled();
      },
    );

    it('el chofer sí sube un PDF a su propia carga', async () => {
      await expect(
        service.upload(
          AttachmentOwnerType.FUEL_LOAD,
          'c1',
          'd1',
          archivo(),
          undefined,
          CHOFER,
        ),
      ).resolves.toMatchObject({ mimeType: 'application/pdf' });
    });

    it('el trabajo extra corre en la misma transacción que el guardado', async () => {
      const orden: string[] = [];
      attachments.save.mockImplementation((a: Attachment) => {
        orden.push('save');
        return Promise.resolve(a);
      });
      cleanup.confirmUpload.mockImplementation(() => {
        orden.push('confirm');
        return Promise.resolve();
      });
      const dentro = jest.fn(() => {
        orden.push('dentro');
        return Promise.resolve();
      });
      await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo(),
        undefined,
        ADMIN,
        { dentro },
      );
      expect(dentro).toHaveBeenCalledWith(
        expect.objectContaining({ save: attachments.save }),
        expect.objectContaining({ ownerId: 'e1' }),
      );
      expect(orden).toEqual(['save', 'dentro', 'confirm']);
    });

    it('si el trabajo extra falla, no queda el archivo y el error llega tal cual', async () => {
      const dentro = jest.fn().mockRejectedValue(new NotFoundException('x'));
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo(),
          undefined,
          ADMIN,
          { dentro },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cleanup.removeInBackground).toHaveBeenCalledTimes(1);
      expect(cleanup.confirmUpload).not.toHaveBeenCalled();
    });

    it('si falla el guardado en la base, borra el archivo del storage', async () => {
      attachments.save.mockRejectedValue(new Error('boom'));
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo(),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeDefined();
      expect(cleanup.removeInBackground).toHaveBeenCalledTimes(1);
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  describe('chofer', () => {
    it('no puede tocar un tipo que no está en su lista (403)', async () => {
      await expect(
        service.list(AttachmentOwnerType.EMPLOYEE, 'e1', 'd1', CHOFER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('puede listar los de su propia carga', async () => {
      attachments.find.mockResolvedValue([]);
      await service.list(AttachmentOwnerType.FUEL_LOAD, 'c1', 'd1', CHOFER);
      expect(resolverCarga.isOwnedByUser).toHaveBeenCalledWith(
        'c1',
        'u-chofer',
        'd1',
      );
    });

    it('si la carga no es suya es 404', async () => {
      resolverCarga.isOwnedByUser.mockResolvedValue(false);
      await expect(
        service.list(AttachmentOwnerType.FUEL_LOAD, 'c1', 'd1', CHOFER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un resolver sin isOwnedByUser equivale a "no es suyo"', async () => {
      const registry = new AttachmentOwnerRegistry();
      registry.register({
        ownerType: AttachmentOwnerType.FUEL_LOAD,
        assertOwner: jest.fn().mockResolvedValue(undefined),
      });
      const s = new AttachmentService(
        attachments as unknown as Repository<Attachment>,
        registry,
        storage as unknown as S3Service,
        cleanup as unknown as S3CleanupService,
      );
      await expect(
        s.list(AttachmentOwnerType.FUEL_LOAD, 'c1', 'd1', CHOFER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sólo borra lo que subió él', async () => {
      attachments.findOne.mockResolvedValue({
        attachmentId: 'a1',
        ownerType: AttachmentOwnerType.FUEL_LOAD,
        ownerId: 'c1',
        storageKey: 'k',
        uploadedByUserId: 'u-admin',
      });
      await expect(service.remove('a1', 'd1', CHOFER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(attachments.softRemove).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('acota por distribuidora, tipo y dueño', async () => {
      attachments.find.mockResolvedValue([]);
      await service.list(AttachmentOwnerType.EMPLOYEE, 'e1', 'd1', ADMIN);
      expect(attachments.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { distributorId: 'd1', ownerType: 'employee', ownerId: 'e1' },
        }),
      );
    });
  });

  describe('getDownload / remove', () => {
    const adjunto = {
      attachmentId: 'a1',
      ownerType: AttachmentOwnerType.EMPLOYEE,
      ownerId: 'e1',
      storageKey: 'k',
      originalName: 'dni.pdf',
      mimeType: 'application/pdf',
      uploadedByUserId: 'u-admin',
    };

    it('busca el adjunto acotado por distribuidora; si no está, 404', async () => {
      attachments.findOne.mockResolvedValue(null);
      await expect(
        service.getDownload('a1', 'd2', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attachments.findOne).toHaveBeenCalledWith({
        where: { attachmentId: 'a1', distributorId: 'd2' },
      });
    });

    it('devuelve la URL firmada para redirigir', async () => {
      attachments.findOne.mockResolvedValue(adjunto);
      storage.getSignedDownload.mockResolvedValue({
        url: 'https://s3/firmada',
        expiresAt: new Date(),
      });
      await expect(service.getDownload('a1', 'd1', ADMIN)).resolves.toBe(
        'https://s3/firmada',
      );
    });

    it('con el dueño borrado, el admin igual baja y borra el adjunto', async () => {
      resolverEmpleado.assertOwner.mockRejectedValue(new NotFoundException());
      attachments.findOne.mockResolvedValue(adjunto);
      storage.getSignedDownload.mockResolvedValue({
        url: 'https://s3/firmada',
        expiresAt: new Date(),
      });
      await expect(service.getDownload('a1', 'd1', ADMIN)).resolves.toBe(
        'https://s3/firmada',
      );
      await service.remove('a1', 'd1', ADMIN);
      expect(attachments.softRemove).toHaveBeenCalled();
      expect(resolverEmpleado.assertOwner).not.toHaveBeenCalled();
    });

    it('el comprobante de una cuota de seguro no se da de baja por el endpoint genérico', async () => {
      attachments.findOne.mockResolvedValue({
        ...adjunto,
        ownerType: AttachmentOwnerType.INSURANCE_INSTALLMENT,
      });
      await expect(service.remove('a1', 'd1', ADMIN)).rejects.toThrow(
        /POST \/insurance-installments/,
      );
      expect(attachments.softRemove).not.toHaveBeenCalled();
    });

    it('el comprobante de una multa no se da de baja por el endpoint genérico', async () => {
      attachments.findOne.mockResolvedValue({
        ...adjunto,
        ownerType: AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
      });
      await expect(service.remove('a1', 'd1', ADMIN)).rejects.toThrow(
        /POST \/traffic-fines/,
      );
      expect(attachments.softRemove).not.toHaveBeenCalled();
    });

    it('pide la URL firmada con el nombre original', async () => {
      attachments.findOne.mockResolvedValue(adjunto);
      storage.getSignedDownload.mockResolvedValue({
        url: 'https://s3/firmada',
        expiresAt: new Date(),
      });
      await service.getDownload('a1', 'd1', ADMIN);
      expect(storage.getSignedDownload).toHaveBeenCalledWith('k', {
        fileName: 'dni.pdf',
        disposition: undefined,
        contentType: 'application/pdf',
      });
    });

    it('el borrado del archivo no espera ni puede romper la respuesta', async () => {
      attachments.findOne.mockResolvedValue(adjunto);
      await expect(service.remove('a1', 'd1', ADMIN)).resolves.toBeUndefined();
      expect(attachments.softRemove).toHaveBeenCalledWith(adjunto);
    });

    it('la baja es lógica: marca el registro y NO toca el archivo del storage', async () => {
      attachments.findOne.mockResolvedValue(adjunto);
      await service.remove('a1', 'd1', ADMIN);
      expect(attachments.softRemove).toHaveBeenCalledWith(adjunto);
      expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      expect(cleanup.scheduleRemoval).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  describe('huérfanos: la intención se anota antes', () => {
    it('al subir: reserva la key ANTES del put y la confirma en la transacción que guarda', async () => {
      await service.upload(
        AttachmentOwnerType.EMPLOYEE,
        'e1',
        'd1',
        archivo(),
        undefined,
        ADMIN,
      );
      const key = (storage.put.mock.calls[0] as [{ key: string }])[0].key;
      expect(cleanup.reserveUpload).toHaveBeenCalledWith(key);
      expect(cleanup.reserveUpload.mock.invocationCallOrder[0]).toBeLessThan(
        storage.put.mock.invocationCallOrder[0],
      );
      expect(cleanup.confirmUpload).toHaveBeenCalledWith(
        expect.anything(),
        key,
      );
      expect(attachments.manager.transaction).toHaveBeenCalledTimes(1);
    });

    it('si falla el guardado la reserva NO se confirma y el objeto se borra en segundo plano', async () => {
      attachments.save.mockRejectedValue(new Error('boom'));
      await expect(
        service.upload(
          AttachmentOwnerType.EMPLOYEE,
          'e1',
          'd1',
          archivo(),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeDefined();
      expect(cleanup.confirmUpload).not.toHaveBeenCalled();
      expect(cleanup.removeInBackground).toHaveBeenCalledTimes(1);
    });

    it('si la baja lógica falla, el error se propaga y no se toca el storage', async () => {
      attachments.findOne.mockResolvedValue({
        attachmentId: 'a1',
        ownerType: AttachmentOwnerType.EMPLOYEE,
        ownerId: 'e1',
        storageKey: 'k',
      });
      attachments.softRemove.mockRejectedValue(new Error('base caída'));
      await expect(service.remove('a1', 'd1', ADMIN)).rejects.toThrow();
      expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });
});
