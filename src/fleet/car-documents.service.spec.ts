import {
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AttachmentService } from '../attachment/attachment.service';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { EVENTO_NOTIFICAR_ADMIN } from '../common/events/notificar-admin.event';
import { CarService } from '../car/car.service';
import { DocumentReadingService } from '../document-reading/document-reading.service';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import {
  CarDocumentsService,
  TOPE_DEL_ESCANEO_MS,
} from './car-documents.service';
import { TipoDeDocumentoDeVehiculo } from './dto/car-document.dto';

const CAR = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';
const ATTACHMENT = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f002';

function file(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'documento.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 12,
    buffer: Buffer.from('89504e470d0a1a0a0000000d', 'hex'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as unknown as Express.Multer.File['stream'],
    ...over,
  };
}

describe('CarDocumentsService', () => {
  let service: CarDocumentsService;
  let attachments: {
    upload: jest.Mock;
    list: jest.Mock;
    getSignedDownload: jest.Mock;
    getDownload: jest.Mock;
    removeDelDueno: jest.Mock;
  };
  let readings: { disponible: boolean; leerAdjunto: jest.Mock };
  let cars: { findOne: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    attachments = {
      upload: jest.fn().mockResolvedValue({
        attachmentId: ATTACHMENT,
        ownerType: AttachmentOwnerType.CAR_DOCUMENT,
        ownerId: CAR,
        label: 'Foto de patente',
        originalName: 'documento.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        uploadedByUserId: 'u1',
        uploadedAt: new Date('2026-11-13T10:00:00Z'),
      }),
      list: jest.fn().mockResolvedValue([]),
      getSignedDownload: jest.fn(),
      getDownload: jest.fn(),
      removeDelDueno: jest.fn().mockResolvedValue(undefined),
    };
    readings = { disponible: true, leerAdjunto: jest.fn() };
    cars = {
      findOne: jest
        .fn()
        .mockResolvedValue({ carId: CAR, carPatent: 'AB 123-CD' }),
    };
    events = { emit: jest.fn() };
    service = new CarDocumentsService(
      attachments as unknown as AttachmentService,
      readings as unknown as DocumentReadingService,
      cars as unknown as CarService,
      events as unknown as import('@nestjs/event-emitter').EventEmitter2,
    );
  });

  it('guarda el documento y devuelve campos para precargar, con lectura persistida', async () => {
    readings.leerAdjunto.mockResolvedValue({
      lectura: {
        tipo: TipoDeDocumento.POLIZA,
        campos: [
          { nombre: 'aseguradora', valor: 'Seguros Norte', confianza: 'alta' },
          { nombre: 'numero_de_poliza', valor: 'P-12', confianza: 'alta' },
          { nombre: 'vigencia_hasta', valor: '2027-01-01', confianza: 'alta' },
        ],
        avisos: [],
      },
    });

    const result = await service.uploadDocument(
      CAR,
      TipoDeDocumentoDeVehiculo.SEGURO,
      file(),
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
    );

    expect(attachments.upload).toHaveBeenCalledWith(
      AttachmentOwnerType.CAR_DOCUMENT,
      CAR,
      'd1',
      expect.anything(),
      'Documento de seguro del vehículo',
      { userId: 'u1', role: RoleType.ADMIN },
    );
    expect(readings.leerAdjunto).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: ATTACHMENT,
        opciones: { tipoEsperado: TipoDeDocumento.POLIZA },
      }),
    );
    expect(result.scan.available).toBe(true);
    expect(result.scan.data?.insurer).toBe('Seguros Norte');
    expect(result.scan.data?.policyNumber).toBe('P-12');
    expect(result.scan.data?.expirationDate).toBe('2027-01-01');
  });

  it('sin lector guarda el archivo y devuelve available false', async () => {
    readings.disponible = false;
    readings.leerAdjunto.mockResolvedValue({ lectura: null });

    const result = await service.uploadDocument(
      CAR,
      TipoDeDocumentoDeVehiculo.VTV,
      file(),
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
    );

    expect(result.scan).toEqual({ available: false, data: null });
    expect(attachments.upload).toHaveBeenCalledTimes(1);
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
  });

  it('una falla del lector no deshace la carga', async () => {
    readings.leerAdjunto.mockRejectedValue(new Error('caído'));

    const result = await service.uploadDocument(
      CAR,
      TipoDeDocumentoDeVehiculo.CEDULA,
      file(),
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
    );

    expect(result.scan.available).toBe(true);
    expect(result.scan.data).toBeNull();
    expect(typeof result.scan.warning).toBe('string');
    expect(attachments.upload).toHaveBeenCalledTimes(1);
  });

  it('avisa al admin sólo si la foto tiene una patente distinta', async () => {
    readings.leerAdjunto.mockResolvedValue({
      lectura: {
        tipo: TipoDeDocumento.FOTO_DE_PATENTE,
        campos: [{ nombre: 'patente', valor: 'AC-456 EF', confianza: 'alta' }],
        avisos: [],
      },
    });

    const result = await service.uploadPatentPhoto(CAR, file(), 'd1', {
      userId: 'u1',
      role: RoleType.ADMIN,
    });

    expect(result).toMatchObject({
      mismatch: true,
      expectedPatent: 'AB 123-CD',
      readPatent: 'AC456EF',
    });
    expect(result.warning).toMatch(/no coincide/);
    expect(readings.leerAdjunto).toHaveBeenCalledWith(
      expect.objectContaining({
        opciones: { tipoEsperado: TipoDeDocumento.FOTO_DE_PATENTE },
      }),
    );
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        distributorId: 'd1',
        kind: 'car_patent_mismatch',
        link: { entity: 'car', id: CAR },
        dedupeKey: `car-patent-mismatch:${CAR}:AB123CD:AC456EF`,
      }),
    );
  });

  it('el aviso se dedupea por vehículo y patentes, no por foto', async () => {
    const leer = (patente: string) =>
      readings.leerAdjunto.mockResolvedValueOnce({
        lectura: {
          tipo: TipoDeDocumento.FOTO_DE_PATENTE,
          campos: [{ nombre: 'patente', valor: patente, confianza: 'alta' }],
          avisos: [],
        },
      });
    const otraFoto = (id: string) =>
      attachments.upload.mockResolvedValueOnce({
        attachmentId: id,
        ownerType: AttachmentOwnerType.CAR_DOCUMENT,
        ownerId: CAR,
        label: 'Foto de patente',
        originalName: 'documento.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        uploadedByUserId: 'u1',
        uploadedAt: new Date('2026-11-13T10:00:00Z'),
      });
    const actor = { userId: 'u1', role: RoleType.ADMIN };
    leer('AC456EF');
    otraFoto('foto-1');
    await service.uploadPatentPhoto(CAR, file(), 'd1', actor);
    leer('ac 456-ef');
    otraFoto('foto-2');
    await service.uploadPatentPhoto(CAR, file(), 'd1', actor);
    leer('AD789GH');
    otraFoto('foto-3');
    await service.uploadPatentPhoto(CAR, file(), 'd1', actor);

    const claves = events.emit.mock.calls.map(
      ([, evento]) => (evento as { dedupeKey: string }).dedupeKey,
    );
    expect(claves).toEqual([
      `car-patent-mismatch:${CAR}:AB123CD:AC456EF`,
      `car-patent-mismatch:${CAR}:AB123CD:AC456EF`,
      `car-patent-mismatch:${CAR}:AB123CD:AD789GH`,
    ]);
  });

  it('lista los documentos del vehículo desde su endpoint', async () => {
    attachments.list.mockResolvedValue([
      {
        attachmentId: ATTACHMENT,
        ownerType: AttachmentOwnerType.CAR_DOCUMENT,
        ownerId: CAR,
        label: 'Foto de patente',
        originalName: 'p.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        uploadedByUserId: 'u1',
        uploadedAt: new Date('2026-11-13T10:00:00Z'),
      },
    ]);
    const lista = await service.list(CAR, 'd1', {
      userId: 'u1',
      role: RoleType.ADMIN,
    });
    expect(attachments.list).toHaveBeenCalledWith(
      AttachmentOwnerType.CAR_DOCUMENT,
      CAR,
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
      true,
    );
    expect(lista).toEqual([
      expect.objectContaining({
        attachmentId: ATTACHMENT,
        label: 'Foto de patente',
      }),
    ]);
  });

  it('baja y da de baja sólo adjuntos de ese vehículo, tras validar el tenant', async () => {
    const actor = { userId: 'u1', role: RoleType.ADMIN };
    const dueno = { ownerType: AttachmentOwnerType.CAR_DOCUMENT, ownerId: CAR };
    attachments.getSignedDownload.mockResolvedValue({ url: 'u' });
    attachments.getDownload.mockResolvedValue('u');
    await service.downloadLink(CAR, ATTACHMENT, 'd1', actor, 'inline');
    await service.downloadUrl(CAR, ATTACHMENT, 'd1', actor);
    await service.remove(CAR, ATTACHMENT, 'd1', actor);
    expect(attachments.getSignedDownload).toHaveBeenCalledWith(
      ATTACHMENT,
      'd1',
      actor,
      'inline',
      dueno,
    );
    expect(attachments.getDownload).toHaveBeenCalledWith(
      ATTACHMENT,
      'd1',
      actor,
      undefined,
      dueno,
    );
    expect(attachments.removeDelDueno).toHaveBeenCalledWith(
      ATTACHMENT,
      dueno,
      'd1',
      actor,
    );
    expect(cars.findOne).toHaveBeenCalledTimes(3);
  });

  it('un vehículo ajeno corta la baja y la descarga antes de tocar el adjunto', async () => {
    cars.findOne.mockRejectedValue(
      new NotFoundException('Vehículo no encontrado'),
    );
    const actor = { userId: 'u1', role: RoleType.ADMIN };
    await expect(
      service.remove(CAR, ATTACHMENT, 'd2', actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.downloadLink(CAR, ATTACHMENT, 'd2', actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(attachments.removeDelDueno).not.toHaveBeenCalled();
    expect(attachments.getSignedDownload).not.toHaveBeenCalled();
  });

  it('no avisa si la patente coincide al normalizarla', async () => {
    readings.leerAdjunto.mockResolvedValue({
      lectura: {
        tipo: TipoDeDocumento.FOTO_DE_PATENTE,
        campos: [{ nombre: 'patente', valor: 'ab123cd', confianza: 'alta' }],
        avisos: [],
      },
    });

    const result = await service.uploadPatentPhoto(CAR, file(), 'd1', {
      userId: 'u1',
      role: RoleType.ADMIN,
    });

    expect(result.mismatch).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.readPatent).toBe('AB123CD');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('sin patente leída no hay advertencia ni aviso', async () => {
    readings.leerAdjunto.mockResolvedValue({ lectura: null });

    const result = await service.uploadPatentPhoto(CAR, file(), 'd1', {
      userId: 'u1',
      role: RoleType.ADMIN,
    });

    expect(result).toMatchObject({
      mismatch: false,
      readPatent: null,
      warning: null,
    });
    expect(result.scan.warning).toMatch(/cargá los datos a mano/);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('un vehículo de otra distribuidora corta antes de guardar o leer', async () => {
    cars.findOne.mockRejectedValue(
      new NotFoundException('Vehículo no encontrado'),
    );

    await expect(
      service.uploadDocument(CAR, TipoDeDocumentoDeVehiculo.VTV, file(), 'd2', {
        userId: 'u1',
        role: RoleType.ADMIN,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.uploadPatentPhoto(CAR, file(), 'd2', {
        userId: 'u1',
        role: RoleType.ADMIN,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cars.findOne).toHaveBeenCalledWith(CAR, 'd2');
    expect(attachments.upload).not.toHaveBeenCalled();
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
  });

  it('un documento que no es PDF ni imagen se rechaza sin guardarlo', async () => {
    await expect(
      service.uploadDocument(
        CAR,
        TipoDeDocumentoDeVehiculo.OTRO,
        file({ mimetype: 'text/csv' }),
        'd1',
        { userId: 'u1', role: RoleType.ADMIN },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(attachments.upload).not.toHaveBeenCalled();
  });

  it('sin archivo deja que el adjunto responda el 400 y no escanea', async () => {
    attachments.upload.mockRejectedValue(new Error('Falta el archivo'));

    await expect(
      service.uploadDocument(
        CAR,
        TipoDeDocumentoDeVehiculo.OTRO,
        undefined,
        'd1',
        { userId: 'u1', role: RoleType.ADMIN },
      ),
    ).rejects.toThrow('Falta el archivo');
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
  });

  it('el tipo "otro" se lee sin tipo esperado y una VTV precarga vencimiento y emisión', async () => {
    readings.leerAdjunto.mockResolvedValue({
      lectura: {
        tipo: TipoDeDocumento.REVISION_TECNICA,
        campos: [
          {
            nombre: 'fecha_de_revision',
            valor: '2026-05-01',
            confianza: 'alta',
          },
          { nombre: 'vencimiento', valor: '2027-05-01', confianza: 'alta' },
          { nombre: 'patente', valor: 'AB123CD', confianza: 'alta' },
        ],
        avisos: ['borroso'],
      },
    });

    const result = await service.uploadDocument(
      CAR,
      TipoDeDocumentoDeVehiculo.OTRO,
      file(),
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
    );

    expect(readings.leerAdjunto).toHaveBeenCalledWith(
      expect.objectContaining({ opciones: undefined }),
    );
    expect(result.scan.data).toEqual({
      detectedType: TipoDeDocumento.REVISION_TECNICA,
      expirationDate: '2027-05-01',
      issueDate: '2026-05-01',
      insurer: null,
      policyNumber: null,
      patent: 'AB123CD',
      warnings: ['borroso'],
    });
  });

  it('un lector colgado se corta a los 30 s y la subida vale igual', async () => {
    jest.useFakeTimers();
    try {
      readings.leerAdjunto.mockReturnValue(new Promise(() => undefined));
      const pendiente = service.uploadDocument(
        CAR,
        TipoDeDocumentoDeVehiculo.SEGURO,
        file(),
        'd1',
        { userId: 'u1', role: RoleType.ADMIN },
      );
      await jest.advanceTimersByTimeAsync(TOPE_DEL_ESCANEO_MS);
      const result = await pendiente;
      expect(result.scan).toMatchObject({ available: true, data: null });
      expect(result.scan.warning).toMatch(/tardó demasiado/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rechaza un tipo que no puede escanear y no guarda nada', async () => {
    await expect(
      service.uploadPatentPhoto(
        CAR,
        file({ mimetype: 'application/pdf' }),
        'd1',
        {
          userId: 'u1',
          role: RoleType.ADMIN,
        },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(attachments.upload).not.toHaveBeenCalled();
  });
});
