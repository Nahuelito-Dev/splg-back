import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import {
  RecompraEstimada,
  RepurchaseEstimatorService,
} from './repurchase-estimator.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseReportService } from './repurchase-report.service';

const DIA = 86_400_000;
const AHORA = new Date('2026-10-31T15:00:00Z');

const cliente = (userId: string, dias: number): RecompraEstimada =>
  ({
    userId,
    estimate: { estimatedAt: new Date(AHORA.getTime() + dias * DIA) },
  }) as RecompraEstimada;

describe('RepurchaseReportService', () => {
  let estimator: {
    parametros: jest.Mock;
    estimar: jest.Mock;
    estimarCliente: jest.Mock;
  };
  let invitaciones: {
    abiertasDe: jest.Mock;
    listar: jest.Mock;
    resumen: jest.Mock;
    comprasPosteriores: jest.Mock;
  };
  let service: RepurchaseReportService;

  beforeEach(() => {
    estimator = {
      parametros: jest.fn().mockResolvedValue({}),
      estimar: jest.fn().mockResolvedValue([]),
      estimarCliente: jest.fn(),
    };
    invitaciones = {
      abiertasDe: jest.fn().mockResolvedValue(new Map()),
      listar: jest.fn().mockResolvedValue([[], 0]),
      resumen: jest.fn().mockResolvedValue({ counts: {}, acceptedRevenue: 0 }),
      comprasPosteriores: jest.fn().mockResolvedValue([]),
    };
    service = new RepurchaseReportService(
      estimator as unknown as RepurchaseEstimatorService,
      invitaciones as unknown as RepurchaseInvitationService,
    );
  });

  describe('proximas (CU-146)', () => {
    it('lista a los que se les acaba el gas dentro de la ventana, del más próximo al más lejano', async () => {
      estimator.estimar.mockResolvedValue([
        cliente('atrasado', -3),
        cliente('esta-semana', 5),
        cliente('lejos', 40),
      ]);
      const abierta = { invitationId: 'i1' } as RepurchaseInvitation;
      invitaciones.abiertasDe.mockResolvedValue(
        new Map([['atrasado', abierta]]),
      );

      const r = await service.proximas(
        'd1',
        14,
        { limit: 20, offset: 0 },
        AHORA,
      );

      expect(r.total).toBe(2);
      expect(r.filas.map((f) => f.cliente.userId)).toEqual([
        'atrasado',
        'esta-semana',
      ]);
      expect(r.filas[0].abierta).toBe(abierta);
      expect(r.filas[1].abierta).toBeNull();
    });

    it('pagina sobre la ventana y busca las invitaciones sólo de la página', async () => {
      estimator.estimar.mockResolvedValue([
        cliente('a', 1),
        cliente('b', 2),
        cliente('c', 3),
      ]);
      const r = await service.proximas(
        'd1',
        14,
        { limit: 1, offset: 1 },
        AHORA,
      );
      expect(r.total).toBe(3);
      expect(r.filas.map((f) => f.cliente.userId)).toEqual(['b']);
      expect(invitaciones.abiertasDe).toHaveBeenCalledWith('d1', ['b']);
    });

    it('sin nadie en la ventana, listado vacío', async () => {
      const r = await service.proximas(
        'd1',
        7,
        { limit: 20, offset: 0 },
        AHORA,
      );
      expect(r).toEqual({ filas: [], total: 0 });
    });
  });

  describe('delCliente', () => {
    it('devuelve la evaluación y su invitación abierta', async () => {
      const evaluacion = { userId: 'u1', cliente: null, reason: 'stale' };
      estimator.estimarCliente.mockResolvedValue(evaluacion);
      const abierta = { invitationId: 'i1' } as RepurchaseInvitation;
      invitaciones.abiertasDe.mockResolvedValue(new Map([['u1', abierta]]));
      expect(await service.delCliente('d1', 'u1', AHORA)).toEqual({
        evaluacion,
        abierta,
      });
    });

    it('sin invitación abierta devuelve null', async () => {
      estimator.estimarCliente.mockResolvedValue({ userId: 'u1' });
      expect((await service.delCliente('d1', 'u1', AHORA)).abierta).toBeNull();
    });

    it('un cliente que no es de la distribuidora es 404', async () => {
      estimator.estimarCliente.mockResolvedValue(null);
      await expect(service.delCliente('d1', 'ajeno', AHORA)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listar', () => {
    it('traduce los días argentinos a instantes y `to` es inclusivo', async () => {
      await service.listar('d1', {
        status: Estado.EXPIRED,
        userId: 'u1',
        from: '2026-10-01',
        to: '2026-10-31',
        limit: 5,
        offset: 10,
      });
      expect(invitaciones.listar).toHaveBeenCalledWith('d1', {
        status: Estado.EXPIRED,
        userId: 'u1',
        from: new Date('2026-10-01T03:00:00Z'),
        to: new Date('2026-11-01T03:00:00Z'),
        limit: 5,
        offset: 10,
      });
    });

    it('sin fechas no filtra por período y la página por omisión es de 10', async () => {
      await service.listar('d1', {});
      expect(invitaciones.listar).toHaveBeenCalledWith('d1', {
        status: undefined,
        userId: undefined,
        from: undefined,
        to: undefined,
        limit: 10,
        offset: 0,
      });
    });

    it('un período al revés es 400', async () => {
      await expect(
        service.listar('d1', { from: '2026-10-31', to: '2026-10-01' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resumen', () => {
    it('por omisión mira los últimos 90 días hasta hoy', async () => {
      const r = await service.resumen('d1', undefined, undefined, AHORA);
      expect(invitaciones.resumen).toHaveBeenCalledWith(
        'd1',
        new Date('2026-08-02T03:00:00Z'),
        new Date('2026-11-01T03:00:00Z'),
      );
      expect(r.desde).toEqual(new Date('2026-08-02T03:00:00Z'));
      expect(r.hasta).toEqual(new Date('2026-11-01T03:00:00Z'));
    });

    it('sin compras posteriores el acierto no tiene medidas', async () => {
      const r = await service.resumen('d1', undefined, undefined, AHORA);
      expect(r.accuracy).toMatchObject({
        measured: 0,
        meanAbsoluteErrorDays: null,
        marginDays: 3,
      });
    });

    it('mide el error de cada invitación contra su primera compra posterior', async () => {
      invitaciones.comprasPosteriores.mockResolvedValue([
        // compró 2 días después, 5 antes y el mismo día
        {
          predicha: new Date('2026-10-10T15:00:00Z'),
          real: new Date('2026-10-12T15:00:00Z'),
        },
        {
          predicha: new Date('2026-10-10T15:00:00Z'),
          real: new Date('2026-10-05T15:00:00Z'),
        },
        {
          predicha: new Date('2026-10-10T15:00:00Z'),
          real: new Date('2026-10-10T18:00:00Z'),
        },
      ]);
      const r = await service.resumen('d1', undefined, undefined, AHORA);
      expect(r.accuracy).toEqual({
        measured: 3,
        meanAbsoluteErrorDays: 2.33,
        withinMarginRate: 0.67,
        marginDays: 3,
        meanBiasDays: -1,
      });
    });

    it('rechaza un día inválido', async () => {
      await expect(
        service.resumen('d1', '2026-13-45', undefined, AHORA),
      ).rejects.toThrow('YYYY-MM-DD');
    });
  });
});
