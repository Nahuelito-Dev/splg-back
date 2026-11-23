import type { PlatformMetricsRepository } from '../infrastructure/platform-metrics.repository';
import { mesDe } from './periodo';
import {
  PlatformUsageService,
  porcentajeDelTope,
} from './platform-usage.service';
import type { EntityPhotoService } from '../../s3/entity-photo.service';

/** Firma de mentira: la key con una marca, `null` si no hay foto. */
const urlDe = jest.fn((key: string | null | undefined) =>
  Promise.resolve(key ? `https://s3.test/${key}?firma` : null),
);
const fotos = { urlDe } as unknown as EntityPhotoService;

const MES = mesDe('2026-11');

function armar() {
  const repo = {
    nombres: jest.fn().mockResolvedValue([
      { id: 'a', name: 'Alfa', logo_key: 'distributors/a/logo/x.png' },
      { id: 'b', name: 'Beta', logo_key: null },
      { id: 'c', name: 'Gama', logo_key: null },
    ]),
    lector: jest.fn().mockResolvedValue([
      { id: 'a', lecturas: 2, costo: '0.100000' },
      { id: 'b', lecturas: 10, costo: '0.200001' },
      // De una empresa dada de baja: no suma.
      { id: 'z', lecturas: 7, costo: '5.000000' },
    ]),
    parametrosDelLector: jest
      .fn()
      .mockResolvedValue([
        { id: 'b', params: { enabled: 1, monthlyBudgetUsd: 4 } },
      ]),
  };
  const service = new PlatformUsageService(
    repo as unknown as PlatformMetricsRepository,
    fotos,
  );
  return { service, repo };
}

describe('PlatformUsageService', () => {
  it('por empresa: lecturas, costo, tope y porcentaje, de mayor a menor costo; las que no leyeron en cero', async () => {
    const { service, repo } = armar();
    const r = await service.porEmpresa(MES);
    expect(r.month).toBe('2026-11');
    expect(r.items.map((i) => [i.name, i.readings, i.costUsd])).toEqual([
      ['Beta', 10, 0.200001],
      ['Alfa', 2, 0.1],
      ['Gama', 0, 0],
    ]);
    expect(r.items[0]).toMatchObject({
      enabled: true,
      monthlyBudgetUsd: 4,
      budgetUsedPct: 5,
    });
    // Sin configuración: los valores por omisión (apagado, US$ 20).
    expect(r.items[1]).toMatchObject({ enabled: false, monthlyBudgetUsd: 20 });
    expect(r.totalReadings).toBe(12);
    expect(r.totalCostUsd).toBe(0.300001);
    // Una consulta para todas las empresas en el mes pedido.
    expect(repo.lector).toHaveBeenCalledWith(null, MES.desde, MES.hasta);
    expect(repo.lector).toHaveBeenCalledTimes(1);
  });

  it('cada empresa con su logo firmado, o null si no tiene; la key llega con las empresas (una sola consulta)', async () => {
    urlDe.mockClear();
    const { service, repo } = armar();
    const r = await service.porEmpresa(MES);
    expect(r.items.map((i) => [i.name, i.logoUrl])).toEqual([
      ['Beta', null],
      ['Alfa', 'https://s3.test/distributors/a/logo/x.png?firma'],
      ['Gama', null],
    ]);
    expect(repo.nombres).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain('logo_key');
  });

  it('el total del mes del tablero (no firma logos: no los muestra)', async () => {
    urlDe.mockClear();
    const { service } = armar();
    expect(await service.totalDelMes(MES)).toEqual({
      month: '2026-11',
      readings: 12,
      costUsd: 0.300001,
    });
    expect(urlDe).not.toHaveBeenCalled();
  });

  it('una empresa: su uso y su tope', async () => {
    const { service, repo } = armar();
    repo.lector.mockResolvedValue([{ id: 'b', lecturas: 3, costo: '0.75' }]);
    repo.parametrosDelLector.mockResolvedValue([
      { id: 'b', params: { enabled: 1, monthlyBudgetUsd: 4 } },
    ]);
    expect(await service.deLaEmpresa('b', MES)).toEqual({
      month: '2026-11',
      readings: 3,
      costUsd: 0.75,
      enabled: true,
      monthlyBudgetUsd: 4,
    });
    expect(repo.lector).toHaveBeenCalledWith(['b'], MES.desde, MES.hasta);
  });

  it('una empresa sin lecturas ni configuración', async () => {
    const { service, repo } = armar();
    repo.lector.mockResolvedValue([]);
    repo.parametrosDelLector.mockResolvedValue([]);
    expect(await service.deLaEmpresa('c', MES)).toMatchObject({
      readings: 0,
      costUsd: 0,
      enabled: false,
      monthlyBudgetUsd: 20,
    });
  });

  it.each([
    [1, 4, 25],
    [0.333333, 1, 33.33],
    [5, 0, 0],
  ])('porcentaje del tope: %s de %s es %s', (costo, tope, pct) => {
    expect(porcentajeDelTope(costo, tope)).toBe(pct);
  });
});
