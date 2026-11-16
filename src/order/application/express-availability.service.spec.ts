import { ExpressAvailabilityService } from './express-availability.service';
import { ExpressSettingsService } from '../../distributor/express-settings.service';
import { CoverageZoneService } from '../../coverage-zone/coverage-zone.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { expressSettingsPorDefecto } from '../../distributor/express-settings';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';

describe('ExpressAvailabilityService (CU-148)', () => {
  let service: ExpressAvailabilityService;
  let settings: { obtener: jest.Mock };
  let coverage: { checkCoverage: jest.Mock };
  let orchestrator: { choferesEnMotoCerca: jest.Mock };
  let acceso: { habilitado: jest.Mock };

  const direccion = {
    location: { type: 'Point' as const, coordinates: [-55.9, -27.37] },
  };
  /** 12:00 ART: dentro del horario por omisión. */
  const mediodia = new Date('2026-10-17T15:00:00Z');

  beforeEach(() => {
    settings = {
      obtener: jest.fn().mockResolvedValue({
        ...expressSettingsPorDefecto(),
        enabled: true,
        surchargeAmount: 1500,
        maxRadiusKm: 7,
      }),
    };
    coverage = {
      checkCoverage: jest.fn().mockResolvedValue({ covered: true }),
    };
    orchestrator = {
      choferesEnMotoCerca: jest.fn().mockResolvedValue(['moto-1']),
    };
    acceso = { habilitado: jest.fn().mockResolvedValue(true) };
    service = new ExpressAvailabilityService(
      settings as unknown as ExpressSettingsService,
      coverage as unknown as CoverageZoneService,
      orchestrator as unknown as DispatchOrchestratorService,
      acceso as unknown as AccesoDeLaEmpresa,
    );
  });

  it('disponible con cobertura, horario y una moto en el radio express', async () => {
    const r = await service.evaluar('d1', direccion, mediodia);

    expect(r).toMatchObject({ available: true, reason: null, message: null });
    expect(r.settings.surchargeAmount).toBe(1500);
    expect(orchestrator.choferesEnMotoCerca).toHaveBeenCalledWith(
      -27.37,
      -55.9,
      'd1',
      7,
    );
  });

  it('apagada por la distribuidora: no mira nada más', async () => {
    settings.obtener.mockResolvedValue(expressSettingsPorDefecto());

    const r = await service.evaluar('d1', direccion, mediodia);

    expect(r.reason).toBe('disabled');
    expect(coverage.checkCoverage).not.toHaveBeenCalled();
    expect(orchestrator.choferesEnMotoCerca).not.toHaveBeenCalled();
  });

  it('sin el módulo express habilitado por la plataforma no se ofrece aunque la empresa la encendió', async () => {
    acceso.habilitado.mockResolvedValue(false);

    const r = await service.evaluar('d1', direccion, mediodia);

    expect(r).toMatchObject({ available: false, reason: 'disabled' });
    expect(acceso.habilitado).toHaveBeenCalledWith('d1', 'express');
    expect(coverage.checkCoverage).not.toHaveBeenCalled();
  });

  it('dirección sin ubicación', async () => {
    expect((await service.evaluar('d1', {}, mediodia)).reason).toBe(
      'no_location',
    );
  });

  it('fuera de la cobertura', async () => {
    coverage.checkCoverage.mockResolvedValue({ covered: false });

    const r = await service.evaluar('d1', direccion, mediodia);

    expect(r).toMatchObject({ available: false, reason: 'out_of_coverage' });
    expect(orchestrator.choferesEnMotoCerca).not.toHaveBeenCalled();
  });

  it('fuera del horario de servicio', async () => {
    // 22:00 ART
    const r = await service.evaluar(
      'd1',
      direccion,
      new Date('2026-10-18T01:00:00Z'),
    );

    expect(r.reason).toBe('out_of_hours');
    expect(orchestrator.choferesEnMotoCerca).not.toHaveBeenCalled();
  });

  it('sin una moto disponible dentro del radio', async () => {
    orchestrator.choferesEnMotoCerca.mockResolvedValue([]);

    const r = await service.evaluar('d1', direccion, mediodia);

    expect(r).toMatchObject({
      available: false,
      reason: 'no_motorcycle_driver',
    });
    expect(r.message).toMatch(/moto/);
  });
});
