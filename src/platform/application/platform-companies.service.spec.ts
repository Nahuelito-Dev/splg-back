import { NotFoundException } from '@nestjs/common';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import {
  ProcessHealth,
  ProcessName,
} from '../../process-run/domain/process-catalog';
import type {
  FilaDeEmpresa,
  FilaDeMetricas,
  PlatformMetricsRepository,
} from '../infrastructure/platform-metrics.repository';
import { PlatformCompaniesService } from './platform-companies.service';
import type { EntityPhotoService } from '../../s3/entity-photo.service';
import type {
  PlatformProcessesService,
  SaludDeProcesos,
} from './platform-processes.service';
import type { PlatformUsageService } from './platform-usage.service';

const AHORA = new Date('2026-11-14T13:00:00Z');

const empresa = (
  id: string,
  extra: Partial<FilaDeEmpresa> = {},
): FilaDeEmpresa => ({
  id,
  name: `Empresa ${id}`,
  slug: `empresa-${id}`,
  legal_name: null,
  tax_id: null,
  email: `contacto@${id}.com`,
  status: DistributorStatus.ACTIVE,
  owned_by_platform: false,
  plan: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  support_emergency_allowed: true,
  support_auto_approve: false,
  logo_key: null,
  ...extra,
});

const metricas = (
  id: string,
  facturacion: string,
  extra: Partial<FilaDeMetricas> = {},
): FilaDeMetricas => ({
  id,
  pedidos: 3,
  ventas: 2,
  facturacion,
  choferes: 1,
  clientes: 5,
  ultima_actividad: null,
  soporte_activo: false,
  soporte_pendiente: 0,
  ...extra,
});

const salud: SaludDeProcesos = {
  estados: [
    {
      proceso: ProcessName.CYLINDER_RECOVERY,
      distributorId: 'b',
      ultima: null,
      ultimaBuena: null,
      salud: ProcessHealth.FAILED,
    },
    {
      proceso: ProcessName.FLEET_ALERTS,
      distributorId: null,
      ultima: null,
      ultimaBuena: null,
      salud: ProcessHealth.LATE,
    },
  ],
  fallas: [
    { process: ProcessName.CYLINDER_RECOVERY, distributorId: 'b', failures: 2 },
    { process: ProcessName.FLEET_ALERTS, distributorId: null, failures: 1 },
  ],
};

function armar() {
  const repo = {
    estados: jest.fn().mockResolvedValue([
      { status: 'active', cantidad: 2 },
      { status: 'suspended', cantidad: 1 },
    ]),
    metricas: jest.fn(),
    empresas: jest.fn(),
    empresa: jest.fn(),
    admins: jest.fn().mockResolvedValue([]),
    sesionesRecientes: jest.fn().mockResolvedValue([]),
  };
  const procesos = { leer: jest.fn().mockResolvedValue(salud) };
  const uso = {
    totalDelMes: jest
      .fn()
      .mockResolvedValue({ month: '2026-11', readings: 4, costUsd: 0.5 }),
    deLaEmpresa: jest.fn().mockResolvedValue({
      month: '2026-11',
      readings: 1,
      costUsd: 0.1,
      enabled: true,
      monthlyBudgetUsd: 20,
    }),
  };
  const fotos = {
    urlDe: jest.fn((k: string | null) =>
      Promise.resolve(k ? `https://s3/${k}?X-Amz-Signature=x` : null),
    ),
  };
  const service = new PlatformCompaniesService(
    repo as unknown as PlatformMetricsRepository,
    procesos as unknown as PlatformProcessesService,
    uso as unknown as PlatformUsageService,
    fotos as unknown as EntityPhotoService,
  );
  return { service, repo, procesos, uso, fotos };
}

describe('PlatformCompaniesService', () => {
  describe('tablero', () => {
    it('el total es la suma exacta de las métricas de todas las empresas (pesos con decimal.js)', async () => {
      const { service, repo } = armar();
      repo.metricas.mockResolvedValue([
        metricas('a', '0.10', { soporte_activo: true, soporte_pendiente: 1 }),
        metricas('b', '0.20'),
        metricas('c', '1000000.015', { soporte_pendiente: 2 }),
      ]);
      const r = await service.tablero(undefined, undefined, AHORA);
      expect(r.totals).toEqual({
        orders: 9,
        salesOrders: 6,
        // 0.1 + 0.2 + 1000000.015 sin errores de coma flotante.
        revenue: 1000000.32,
        activeDrivers: 3,
        customers: 15,
      });
      expect(r.companies).toEqual({ total: 3, active: 2, suspended: 1 });
      expect(r.supportSessions).toEqual({ active: 1, pending: 3 });
      expect(r.processes).toEqual({ alerts: 2, failuresLast24h: 3 });
      expect(r.documentReading).toEqual({
        month: '2026-11',
        readings: 4,
        costUsd: 0.5,
      });
      expect(r.range).toEqual({ from: '2026-11-01', to: '2026-11-14' });
      // Todas las empresas (ids nulo) en el período pedido.
      expect(repo.metricas).toHaveBeenCalledWith(
        null,
        new Date('2026-11-01T03:00:00Z'),
        new Date('2026-11-15T03:00:00Z'),
        AHORA,
      );
    });
  });

  describe('listar', () => {
    it('una sola consulta de métricas para toda la página, sin importar cuántas empresas', async () => {
      const { service, repo, procesos } = armar();
      const ids = Array.from({ length: 25 }, (_, i) => `e${i}`);
      repo.empresas.mockResolvedValue({
        filas: ids.map((id) => empresa(id)),
        total: 25,
      });
      repo.metricas.mockResolvedValue(ids.map((id) => metricas(id, '10')));
      const r = await service.listar({ limit: 50, offset: 0 }, AHORA);
      expect(r.items).toHaveLength(25);
      expect(repo.metricas).toHaveBeenCalledTimes(1);
      expect(repo.metricas).toHaveBeenCalledWith(
        ids,
        expect.any(Date),
        expect.any(Date),
        AHORA,
      );
      expect(procesos.leer).toHaveBeenCalledTimes(1);
    });

    it('arma cada fila con sus métricas, alertas y soporte; una empresa sin métricas sale en cero', async () => {
      const { service, repo } = armar();
      repo.empresas.mockResolvedValue({
        filas: [empresa('a'), empresa('b', { status: 'suspended' })],
        total: 2,
      });
      const ultima = new Date('2026-11-10T12:00:00Z');
      repo.metricas.mockResolvedValue([
        metricas('b', '150.5', {
          ultima_actividad: ultima,
          soporte_activo: true,
        }),
      ]);
      const r = await service.listar(
        { limit: 10, offset: 0, status: DistributorStatus.ACTIVE },
        AHORA,
      );
      expect(repo.empresas).toHaveBeenCalledWith('active', null, 10, 0);
      const [a, b] = r.items;
      expect(a.metrics).toEqual({
        orders: 0,
        salesOrders: 0,
        revenue: 0,
        activeDrivers: 0,
        customers: 0,
      });
      expect(a.processAlerts).toBe(0);
      expect(b).toMatchObject({
        status: 'suspended',
        ownedByPlatform: false,
        lastActivityAt: ultima,
        processAlerts: 1,
        supportSessionActive: true,
        metrics: { revenue: 150.5 },
      });
      expect(r.total).toBe(2);
    });

    it('expone el logo firmado de cada empresa, o null si no tiene', async () => {
      const { service, repo, fotos } = armar();
      repo.empresas.mockResolvedValue({
        filas: [empresa('a', { logo_key: 'logos/a.png' }), empresa('b')],
        total: 2,
      });
      repo.metricas.mockResolvedValue([]);
      const r = await service.listar({ limit: 10, offset: 0 }, AHORA);
      expect(r.items.map((i) => i.logoUrl)).toEqual([
        'https://s3/logos/a.png?X-Amz-Signature=x',
        null,
      ]);
      expect(fotos.urlDe).toHaveBeenCalledWith('logos/a.png');
    });

    it('pasa el filtro de empresa propia y expone la marca', async () => {
      const { service, repo } = armar();
      repo.empresas.mockResolvedValue({
        filas: [empresa('propia', { owned_by_platform: true })],
        total: 1,
      });
      repo.metricas.mockResolvedValue([]);

      const r = await service.listar(
        { ownedByPlatform: true, limit: 10, offset: 0 },
        AHORA,
      );

      expect(repo.empresas).toHaveBeenCalledWith(null, true, 10, 0);
      expect(r.items[0].ownedByPlatform).toBe(true);
    });

    it('una página vacía no consulta métricas ni procesos', async () => {
      const { service, repo, procesos } = armar();
      repo.empresas.mockResolvedValue({ filas: [], total: 3 });
      const r = await service.listar({ limit: 10, offset: 50 }, AHORA);
      expect(r).toMatchObject({ items: [], total: 3 });
      expect(repo.metricas).not.toHaveBeenCalled();
      expect(procesos.leer).not.toHaveBeenCalled();
    });
  });

  describe('ficha', () => {
    it('404 si la empresa no existe o está dada de baja', async () => {
      const { service, repo } = armar();
      repo.empresa.mockResolvedValue(null);
      await expect(
        service.ficha('x', undefined, undefined, AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.metricas).not.toHaveBeenCalled();
    });

    it('junta datos, métricas, lector, procesos propios, admins y sesiones', async () => {
      const { service, repo, uso } = armar();
      repo.empresa.mockResolvedValue(
        empresa('b', { tax_id: '30712345678', owned_by_platform: true }),
      );
      repo.metricas.mockResolvedValue([metricas('b', '99.99')]);
      repo.admins.mockResolvedValue([
        {
          distributor_id: 'b',
          user_id: 'u1',
          full_name: 'Lucía',
          email: 'lucia@b.com',
          staff_role: 'Administrador',
          blocked: false,
          last_login_at: null,
          created_at: new Date(),
        },
      ]);
      repo.sesionesRecientes.mockResolvedValue([
        {
          id: 's1',
          distributor_id: 'b',
          kind: 'consented',
          status: 'ended',
          requested_by_name: 'Soporte',
          reason: 'Revisión del despacho de la mañana',
          requested_minutes: 60,
          created_at: new Date('2026-11-10T10:00:00Z'),
          started_at: new Date('2026-11-10T10:05:00Z'),
          expires_at: new Date('2026-11-10T11:05:00Z'),
          ended_at: new Date('2026-11-10T10:30:00Z'),
          end_reason: 'exit',
        },
      ]);
      const r = await service.ficha('b', '2026-11-01', '2026-11-10', AHORA);
      expect(r.company).toMatchObject({
        ownedByPlatform: true,
        id: 'b',
        taxId: '30712345678',
        contactEmail: 'contacto@b.com',
      });
      expect(r.metrics.revenue).toBe(99.99);
      expect(r.range).toEqual({ from: '2026-11-01', to: '2026-11-10' });
      expect(r.processes).toEqual([
        expect.objectContaining({
          process: ProcessName.CYLINDER_RECOVERY,
          health: ProcessHealth.FAILED,
          failuresLast24h: 2,
        }),
      ]);
      expect(r.admins).toEqual([
        expect.objectContaining({ name: 'Lucía', email: 'lucia@b.com' }),
      ]);
      expect(r.supportSessions[0]).toMatchObject({
        id: 's1',
        requestedMinutes: 60,
        endReason: 'exit',
      });
      expect(repo.sesionesRecientes).toHaveBeenCalledWith('b', 10);
      expect(uso.deLaEmpresa).toHaveBeenCalledWith(
        'b',
        expect.objectContaining({ month: '2026-11' }),
      );
    });

    it('la empresa no lleva teléfono, datos bancarios ni credenciales', async () => {
      const { service, repo } = armar();
      repo.empresa.mockResolvedValue({
        ...empresa('a'),
        phone: '+5493764000000',
        bank_cbu: '0000003100010000000001',
      } as FilaDeEmpresa);
      repo.metricas.mockResolvedValue([]);
      const r = await service.ficha('a', undefined, undefined, AHORA);
      const texto = JSON.stringify(r);
      expect(texto).not.toContain('+5493764000000');
      expect(texto).not.toContain('0000003100010000000001');
    });
  });
});
