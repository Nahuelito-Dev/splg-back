import type { Response } from 'express';
import { RoleType } from '../common/constants/role-type.enum';
import { DownloadMode } from '../s3/dto/download-link.dto';
import { CarDocumentsV2Controller } from './car-documents-v2.controller';
import { CarDocumentsService } from './car-documents.service';
import { TipoDeDocumentoDeVehiculo } from './dto/car-document.dto';

const CAR = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';

function file(): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'patente.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 12,
    buffer: Buffer.from('89504e470d0a1a0a0000000d', 'hex'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as unknown as Express.Multer.File['stream'],
  };
}

describe('CarDocumentsV2Controller', () => {
  let controller: CarDocumentsV2Controller;
  let documents: {
    uploadDocument: jest.Mock;
    uploadPatentPhoto: jest.Mock;
    list: jest.Mock;
    downloadLink: jest.Mock;
    downloadUrl: jest.Mock;
    remove: jest.Mock;
  };
  const user = {
    user_id: 'u1',
    email: 'admin@splg.com',
    role: RoleType.ADMIN,
  };

  beforeEach(() => {
    documents = {
      uploadDocument: jest.fn().mockResolvedValue({
        attachment: { attachmentId: 'a1' },
        scan: { available: false, data: null },
      }),
      uploadPatentPhoto: jest.fn().mockResolvedValue({
        attachment: { attachmentId: 'a2' },
        scan: { available: false, data: null },
        mismatch: false,
      }),
      list: jest.fn().mockResolvedValue([{ attachmentId: 'a1' }]),
      downloadLink: jest.fn().mockResolvedValue({
        url: 'https://s3/firmada',
        expiresAt: new Date('2026-11-13T10:05:00Z'),
      }),
      downloadUrl: jest.fn().mockResolvedValue('https://s3/firmada'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    controller = new CarDocumentsV2Controller(
      documents as unknown as CarDocumentsService,
    );
  });

  it('delegar la carga de documento con tenant y actor autenticado', async () => {
    const result = await controller.uploadDocument(
      CAR,
      { documentType: TipoDeDocumentoDeVehiculo.SEGURO },
      file(),
      'd1',
      user,
    );

    expect(documents.uploadDocument).toHaveBeenCalledWith(
      CAR,
      TipoDeDocumentoDeVehiculo.SEGURO,
      expect.objectContaining({ originalname: 'patente.png' }),
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
    );
    expect(result).toEqual({
      attachment: { attachmentId: 'a1' },
      scan: { available: false, data: null },
    });
  });

  it('delegar la foto de patente y conservar la advertencia del servicio', async () => {
    documents.uploadPatentPhoto.mockResolvedValue({
      attachment: { attachmentId: 'a2' },
      scan: { available: true, data: { patent: 'AC456EF' } },
      mismatch: true,
      expectedPatent: 'AB123CD',
      readPatent: 'AC456EF',
    });

    const result = await controller.uploadPatentPhoto(CAR, file(), 'd1', user);

    expect(documents.uploadPatentPhoto).toHaveBeenCalledWith(
      CAR,
      expect.objectContaining({ mimetype: 'image/png' }),
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
    );
    expect(result).toMatchObject({ mismatch: true, readPatent: 'AC456EF' });
  });

  it('lista con tenant y actor', async () => {
    await expect(controller.list(CAR, 'd1', user)).resolves.toEqual([
      { attachmentId: 'a1' },
    ]);
    expect(documents.list).toHaveBeenCalledWith(CAR, 'd1', {
      userId: 'u1',
      role: RoleType.ADMIN,
    });
  });

  it('con modo=url responde el enlace firmado; sin modo, redirige', async () => {
    const res = { json: jest.fn(), redirect: jest.fn() };
    await controller.download(
      CAR,
      'a1',
      { modo: DownloadMode.URL },
      'd1',
      user,
      res as unknown as Response,
    );
    expect(documents.downloadLink).toHaveBeenCalledWith(
      CAR,
      'a1',
      'd1',
      { userId: 'u1', role: RoleType.ADMIN },
      undefined,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://s3/firmada' }),
    );
    await controller.download(
      CAR,
      'a1',
      {},
      'd1',
      user,
      res as unknown as Response,
    );
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://s3/firmada');
  });

  it('da de baja con tenant y actor', async () => {
    await controller.remove(CAR, 'a1', 'd1', user);
    expect(documents.remove).toHaveBeenCalledWith(CAR, 'a1', 'd1', {
      userId: 'u1',
      role: RoleType.ADMIN,
    });
  });
});
