import { Logger } from '@nestjs/common';
import { DistributorService } from '../distributor/distributor.service';
import { Distributor } from '../distributor/entities/distributor.entity';
import { imagenesDePrueba } from '../s3/imagenes-de-prueba';
import { S3Service } from '../s3/s3.service';
import { PdfBrandingService } from './pdf-branding.service';

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe('PdfBrandingService', () => {
  let distribuidoras: { findOne: jest.Mock };
  let almacenamiento: { get: jest.Mock };
  let servicio: PdfBrandingService;

  const distribuidora = (cambios: Partial<Distributor> = {}) =>
    ({
      name: 'Gas del Sur',
      legalName: 'Gas del Sur S.R.L.',
      taxId: '30-71234567-8',
      phone: '376 4123456',
      email: 'ventas@gasdelsur.test',
      logoKey: 'distributors/d1/logo/a.webp',
      ...cambios,
    }) as Distributor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    distribuidoras = { findOne: jest.fn() };
    almacenamiento = { get: jest.fn() };
    servicio = new PdfBrandingService(
      distribuidoras as unknown as DistributorService,
      almacenamiento as unknown as S3Service,
    );
  });

  it('arma el membrete con los datos de la distribuidora y el logo en PNG', async () => {
    distribuidoras.findOne.mockResolvedValue(distribuidora());
    // El logo se subió como WEBP: pdfkit no lo incrusta, se pasa a PNG.
    almacenamiento.get.mockResolvedValue(await imagenesDePrueba.webp());

    const membrete = await servicio.membreteDe('d1');

    expect(distribuidoras.findOne).toHaveBeenCalledWith('d1');
    expect(almacenamiento.get).toHaveBeenCalledWith(
      'distributors/d1/logo/a.webp',
    );
    expect(membrete).toMatchObject({
      nombre: 'Gas del Sur',
      razonSocial: 'Gas del Sur S.R.L.',
      cuit: '30-71234567-8',
      contacto: '376 4123456 · ventas@gasdelsur.test',
    });
    expect([...(membrete.logo as Buffer).subarray(0, 4)]).toEqual(PNG);
  });

  it('sin logo cargado no toca el almacenamiento', async () => {
    distribuidoras.findOne.mockResolvedValue(
      distribuidora({ logoKey: null, phone: null, email: null, taxId: null }),
    );

    const membrete = await servicio.membreteDe('d1');

    expect(almacenamiento.get).not.toHaveBeenCalled();
    expect(membrete.logo).toBeNull();
    expect(membrete.contacto).toBeNull();
    expect(membrete.cuit).toBeNull();
  });

  it('si el logo no se puede leer, el membrete sale sin logo', async () => {
    distribuidoras.findOne.mockResolvedValue(distribuidora());
    almacenamiento.get.mockRejectedValue(new Error('NoSuchKey'));

    const membrete = await servicio.membreteDe('d1');

    expect(membrete.logo).toBeNull();
    expect(membrete.nombre).toBe('Gas del Sur');
  });

  it('un logo que no es una imagen se descarta', async () => {
    distribuidoras.findOne.mockResolvedValue(distribuidora());
    almacenamiento.get.mockResolvedValue(Buffer.from('<html>'));

    expect((await servicio.membreteDe('d1')).logo).toBeNull();
  });

  it('la razón social igual al nombre no se repite', async () => {
    distribuidoras.findOne.mockResolvedValue(
      distribuidora({ legalName: 'Gas del Sur', logoKey: null }),
    );
    expect((await servicio.membreteDe('d1')).razonSocial).toBeNull();
  });
});
