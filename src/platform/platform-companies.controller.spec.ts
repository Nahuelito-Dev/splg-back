import { DistributorService } from '../distributor/distributor.service';
import {
  Distributor,
  DistributorStatus,
} from '../distributor/entities/distributor.entity';
import { PlatformCompaniesController } from './platform-companies.controller';

describe('PlatformCompaniesController', () => {
  const fila = {
    distributorId: 'd1',
    name: 'Distribuidora de prueba OrixTech',
    slug: 'prueba-orixtech',
    status: DistributorStatus.ACTIVE,
    ownedByPlatform: true,
    createdAt: new Date('2026-11-14T12:00:00Z'),
    bankCbu: '0000000000000000000000',
    bankAlias: 'alias.secreto',
  } as unknown as Distributor;
  const servicio = {
    marcarPropia: jest.fn().mockResolvedValue(fila),
  };
  const controller = new PlatformCompaniesController(
    servicio as unknown as DistributorService,
  );
  const esperado = {
    id: 'd1',
    name: 'Distribuidora de prueba OrixTech',
    slug: 'prueba-orixtech',
    status: 'active',
    ownedByPlatform: true,
    createdAt: '2026-11-14T12:00:00.000Z',
  };

  it('marca y devuelve la empresa como la ve la plataforma', async () => {
    await expect(
      controller.marcar('d1', { ownedByPlatform: true }),
    ).resolves.toEqual(esperado);
    expect(servicio.marcarPropia).toHaveBeenCalledWith('d1', true);
  });
});
