import { Repository } from 'typeorm';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { RecoveryCaseStatus } from '../entities/cylinder-recovery-case.entity';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import { CylinderRecoveryNotifier } from './cylinder-recovery.notifier';
import { CylinderRecoveryPickupOpportunityService } from './cylinder-recovery-pickup-opportunity.service';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { parametrosDeRecupero } from './domain/recovery-rules';
import {
  AHORA,
  DIST,
  PARAMETROS,
  unCaso,
  unaOferta,
} from './recovery-test-kit';

describe('CylinderRecoveryPickupOpportunityService', () => {
  const P = parametrosDeRecupero(PARAMETROS);
  let query: jest.Mock;
  let previos: CylinderRecoveryNotice[];
  let caso: CylinderRecoveryCase;
  let guardados: CylinderRecoveryNotice[];
  let engine: { parametros: jest.Mock };
  let notifier: { porSocket: jest.Mock; alClienteAgrupado: jest.Mock };
  let acceso: { habilitado: jest.Mock };
  let service: CylinderRecoveryPickupOpportunityService;
  const candidato = {
    caseId: 'case-1',
    orderId: 'ord-vecino',
    batchId: 'hoja-1',
    sheetNumber: 5,
    meters: 250,
  };

  beforeEach(() => {
    previos = [];
    guardados = [];
    caso = unCaso({ status: RecoveryCaseStatus.OPEN });
    query = jest.fn();
    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(() => Promise.resolve(caso)),
      }),
      find: jest.fn(() => Promise.resolve(previos)),
      create: jest.fn((_e: unknown, v: object) => v),
      save: jest.fn((a: CylinderRecoveryNotice) => {
        guardados.push(a);
        return Promise.resolve(a);
      }),
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ serial: 'SN-001' }),
      }),
    };
    const cases = {
      manager: {
        query,
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
      },
    };
    engine = { parametros: jest.fn().mockResolvedValue(P) };
    notifier = {
      porSocket: jest.fn(),
      alClienteAgrupado: jest.fn().mockResolvedValue(undefined),
    };
    acceso = { habilitado: jest.fn().mockResolvedValue(true) };
    service = new CylinderRecoveryPickupOpportunityService(
      cases as unknown as Repository<CylinderRecoveryCase>,
      engine as unknown as CylinderRecoveryService,
      notifier as unknown as CylinderRecoveryNotifier,
      acceso as unknown as AccesoDeLaEmpresa,
    );
  });

  describe('candidatos', () => {
    it('pasa el radio en metros a la consulta y mide sobre geography', async () => {
      query.mockResolvedValue([{ ...candidato, meters: '250.4' }]);
      const r = await service.candidatos(DIST, 'hoja-1', 300, AHORA);
      expect(r).toEqual([{ ...candidato, meters: 250.4 }]);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ST_DWithin(a."location"::geography');
      expect(sql).toContain("b.kind = 'planned' AND b.status = 'assigned'");
      expect(sql).toContain("n.status IN ('pending', 'accepted')");
      expect(params).toEqual([DIST, expect.any(String), 'hoja-1', 300]);
    });
  });

  describe('ofrecer', () => {
    it('crea la oferta ligada a la hoja y a la parada vecina, sin cargo, y avisa al cliente', async () => {
      query.mockResolvedValue([{ ...candidato, meters: '250' }]);
      const n = await service.ofrecer(DIST, 'hoja-1', AHORA);
      expect(n).toBe(1);
      expect(guardados[0]).toEqual(
        expect.objectContaining({
          kind: RecoveryNoticeKind.PICKUP_OFFER,
          status: ProposalStatus.PENDING,
          orderId: 'ord-vecino',
          routeBatchId: 'hoja-1',
        }),
      );
      expect(notifier.porSocket).toHaveBeenCalledWith(
        caso,
        expect.anything(),
        expect.objectContaining({ retiroAprovechandoLaHoja: true }),
      );
      expect(notifier.alClienteAgrupado).toHaveBeenCalledWith(
        caso.userId,
        expect.any(Array),
      );
    });

    it('con el recupero apagado en la distribuidora o sin módulo no consulta nada', async () => {
      engine.parametros.mockResolvedValue({ ...P, enabled: false });
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
      acceso.habilitado.mockResolvedValue(false);
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it('nunca dos ofertas vivas para el mismo caso', async () => {
      query.mockResolvedValue([{ ...candidato, meters: '250' }]);
      previos = [unaOferta()];
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
      previos = [unaOferta({ status: ProposalStatus.ACCEPTED })];
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
      expect(guardados).toEqual([]);
    });

    it('si la anterior venció o se rechazó puede ofrecer otra, pero no la misma parada', async () => {
      query.mockResolvedValue([{ ...candidato, meters: '250' }]);
      previos = [
        unaOferta({ status: ProposalStatus.REJECTED, orderId: 'otro' }),
      ];
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(1);
      guardados.length = 0;
      previos = [
        unaOferta({ status: ProposalStatus.EXPIRED, orderId: 'ord-vecino' }),
      ];
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
    });

    it('un caso que ya no está abierto no recibe oferta', async () => {
      query.mockResolvedValue([{ ...candidato, meters: '250' }]);
      caso.status = RecoveryCaseStatus.ESCALATED;
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
    });

    it('si otra pasada ofreció primero (índice único) no duplica ni falla', async () => {
      query.mockResolvedValue([{ ...candidato, meters: '250' }]);
      (
        service as unknown as { cases: { manager: { transaction: jest.Mock } } }
      ).cases.manager.transaction.mockRejectedValue(
        Object.assign(new Error('duplicada'), { code: '23505' }),
      );
      expect(await service.ofrecer(DIST, null, AHORA)).toBe(0);
    });

    it('sin distribuidora recorre las que tienen casos abiertos y una que falla no frena a las demás', async () => {
      query
        .mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }])
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([{ ...candidato, meters: '250' }]);
      expect(await service.ofrecer(null, null, AHORA)).toBe(1);
      expect(engine.parametros).toHaveBeenCalledTimes(2);
    });
  });
});
