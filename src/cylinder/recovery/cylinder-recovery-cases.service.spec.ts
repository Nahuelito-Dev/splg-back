import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { DeliveryService } from '../../delivery/delivery.service';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { CylinderService } from '../cylinder.service';
import { CylinderState } from '../entities/cylinder.entity';
import {
  CylinderRecoveryCase,
  RecoveryCaseStatus,
} from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import { CylinderRecoveryCasesService } from './cylinder-recovery-cases.service';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { RecoveryDecision } from './dto/recovery-request.dto';
import {
  AHORA,
  BaseEnMemoria,
  DIA,
  DIST,
  PARAMETROS,
  unAviso,
  unCaso,
  unEnvase,
  unaOferta,
  unPedido,
} from './recovery-test-kit';

describe('CylinderRecoveryCasesService', () => {
  let db: BaseEnMemoria;
  let casesRepo: Record<string, jest.Mock> & {
    manager: {
      transaction: jest.Mock;
      getRepository: jest.Mock;
    };
  };
  let noticesRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let engine: {
    parametros: jest.Mock;
    envasesAfuera: jest.Mock;
    clasificar: jest.Mock;
    cerrarPorDevolucion: jest.Mock;
  };
  let cylinders: {
    getHistory: jest.Mock;
    retireLost: jest.Mock;
    findOne: jest.Mock;
    transition: jest.Mock;
  };
  let orders: { findManyForRecovery: jest.Mock };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let processConfig: {
    vigentes: jest.Mock;
    obtener: jest.Mock;
    guardar: jest.Mock;
  };
  let service: CylinderRecoveryCasesService;
  const ADMIN = 'admin-1';

  const conRelaciones = (c: CylinderRecoveryCase): CylinderRecoveryCase =>
    Object.assign(c, {
      user: { fullName: 'Ana Pérez', email: 'ana@x.com', phoneNumber: '+54 1' },
      cylinder: Object.assign(unEnvase({ cylinderId: c.cylinderId }), {
        gasCylinder: { type: '10kg' },
      }),
    });

  beforeEach(() => {
    db = new BaseEnMemoria();
    db.casos = [
      unCaso({
        status: RecoveryCaseStatus.ESCALATED,
        step: 3,
        exhaustedAt: AHORA,
      }),
    ];
    db.avisos = [unAviso()];
    db.envases = [unEnvase()];
    casesRepo = {
      findAndCount: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      createQueryBuilder: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(db.manager)),
        getRepository: jest.fn(),
      },
    } as unknown as typeof casesRepo;
    noticesRepo = {
      find: jest.fn((opts: { where: { caseId: unknown } }) =>
        Promise.resolve(
          db.avisos.filter((a) => a.caseId === 'case-1' || !opts),
        ),
      ),
      findOne: jest.fn(),
      save: jest.fn((a: unknown) => Promise.resolve(a)),
      createQueryBuilder: jest.fn(),
    };
    engine = {
      parametros: jest.fn().mockResolvedValue(PARAMETROS),
      envasesAfuera: jest.fn().mockResolvedValue([]),
      clasificar: jest
        .fn()
        .mockReturnValue({ retenidos: [], revisionManual: [] }),
      cerrarPorDevolucion: jest.fn().mockResolvedValue(true),
    };
    cylinders = {
      getHistory: jest.fn().mockResolvedValue([]),
      retireLost: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(unEnvase()),
      transition: jest.fn().mockResolvedValue(undefined),
    };
    orders = { findManyForRecovery: jest.fn().mockResolvedValue(new Map()) };
    deliveries = {
      buscarPorIdOUsuario: jest.fn().mockResolvedValue({ deliveryId: 'del-1' }),
    };
    processConfig = {
      vigentes: jest.fn().mockResolvedValue({ process: 'cylinder_recovery' }),
      obtener: jest.fn().mockResolvedValue(PARAMETROS),
      guardar: jest.fn().mockResolvedValue({ process: 'cylinder_recovery' }),
    };
    service = new CylinderRecoveryCasesService(
      casesRepo as unknown as Repository<CylinderRecoveryCase>,
      noticesRepo as unknown as Repository<CylinderRecoveryNotice>,
      engine as unknown as CylinderRecoveryService,
      cylinders as unknown as CylinderService,
      orders as unknown as OrderLookupService,
      deliveries as unknown as DeliveryService,
      processConfig as unknown as ProcessConfigService,
    );
  });

  describe('listar', () => {
    beforeEach(() => {
      casesRepo.findAndCount.mockResolvedValue([
        [conRelaciones(db.casos[0])],
        1,
      ]);
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ status: 'escalated', n: '1' }]),
      };
      casesRepo.createQueryBuilder.mockReturnValue(qb);
    });

    it('lista los casos de la distribuidora con cliente, envase y totales por estado', async () => {
      const r = await service.listar(DIST, { limit: 10, offset: 0 }, AHORA);
      expect(r.total).toBe(1);
      expect(r.counts).toEqual({ escalated: 1 });
      expect(r.data[0]).toEqual(
        expect.objectContaining({
          caseId: 'case-1',
          status: RecoveryCaseStatus.ESCALATED,
          daysOut: 40,
        }),
      );
      expect(r.data[0].customer.fullName).toBe('Ana Pérez');
      expect(r.data[0].cylinder.serial).toBe('SN-001');
      expect(r.data[0].cylinder.product).toBe('10kg');
      const [{ where }] = casesRepo.findAndCount.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where.distributorId).toBe(DIST);
    });

    it('filtra por estado, escalón, cliente y envase', async () => {
      await service.listar(DIST, {
        status: RecoveryCaseStatus.OPEN,
        step: 2,
        customerId: 'cust-1',
        cylinderId: 'cyl-1',
      });
      const [{ where }] = casesRepo.findAndCount.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where).toEqual({
        distributorId: DIST,
        status: RecoveryCaseStatus.OPEN,
        step: 2,
        userId: 'cust-1',
        cylinderId: 'cyl-1',
      });
    });

    it('live deja los casos que siguen en pie (el filtro se resuelve en el back)', async () => {
      await service.listar(DIST, { live: true });
      const [{ where }] = casesRepo.findAndCount.mock.calls[0] as [
        { where: { status: { _value: string[] } } },
      ];
      expect(where.status._value).toEqual([
        RecoveryCaseStatus.OPEN,
        RecoveryCaseStatus.ESCALATED,
        RecoveryCaseStatus.LOST,
      ]);
    });

    it('pending deja los que esperan al administrador', async () => {
      await service.listar(DIST, { pending: true });
      const [{ where }] = casesRepo.findAndCount.mock.calls[0] as [
        { where: { status: { _value: string[] } } },
      ];
      expect(where.status._value).toEqual([
        RecoveryCaseStatus.ESCALATED,
        RecoveryCaseStatus.LOST,
      ]);
    });
  });

  describe('detalle', () => {
    it('arma el legajo: avisos, historial del envase y quién resolvió', async () => {
      const caso = conRelaciones(
        unCaso({
          status: RecoveryCaseStatus.WRITTEN_OFF,
          closedAt: AHORA,
          resolvedByUserId: ADMIN,
          resolutionNote: 'Extraviado',
        }),
      );
      casesRepo.findOne.mockResolvedValue(caso);
      casesRepo.manager.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ fullName: 'Admin SPLG' }),
      });
      cylinders.getHistory.mockResolvedValue([
        {
          movementId: 'm1',
          fromState: CylinderState.DISPATCHED,
          toState: CylinderState.WITH_CUSTOMER,
          orderId: 'ord-1',
          note: 'Entregado',
          createdAt: AHORA,
        },
      ]);
      const r = await service.detalle('case-1', DIST, AHORA);
      expect(r.notices).toHaveLength(1);
      expect(r.history).toEqual([
        expect.objectContaining({ toState: CylinderState.WITH_CUSTOMER }),
      ]);
      expect(r.resolution).toEqual({
        resolvedByUserId: ADMIN,
        resolvedByName: 'Admin SPLG',
        note: 'Extraviado',
      });
      expect(cylinders.getHistory).toHaveBeenCalledWith('cyl-1', DIST);
    });

    it('un caso de otra distribuidora no existe', async () => {
      casesRepo.findOne.mockResolvedValue(null);
      await expect(service.detalle('x', DIST)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const [{ where }] = casesRepo.findOne.mock.calls[0] as [
        { where: object },
      ];
      expect(where).toEqual({ caseId: 'x', distributorId: DIST });
    });
  });

  describe('resolver (paso 11)', () => {
    beforeEach(() => {
      casesRepo.findOne.mockImplementation(() =>
        Promise.resolve(conRelaciones(db.casos[0])),
      );
      casesRepo.manager.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ fullName: 'Admin SPLG' }),
      });
    });

    it('cobrar el depósito: registra la decisión, el importe y quién; no toca el envase', async () => {
      const r = await service.resolver(
        'case-1',
        DIST,
        {
          decision: RecoveryDecision.CHARGE_DEPOSIT,
          note: 'Se cobra con el próximo pedido',
        },
        ADMIN,
        AHORA,
      );
      expect(db.casos[0]).toEqual(
        expect.objectContaining({
          status: RecoveryCaseStatus.DEPOSIT_CHARGED,
          resolvedByUserId: ADMIN,
          resolutionNote: 'Se cobra con el próximo pedido',
          closedAt: AHORA,
          depositAmount: 70000,
        }),
      );
      expect(cylinders.retireLost).not.toHaveBeenCalled();
      expect(r.status).toBe(RecoveryCaseStatus.DEPOSIT_CHARGED);
    });

    it('cerrar sin cargo', async () => {
      await service.resolver(
        'case-1',
        DIST,
        {
          decision: RecoveryDecision.CLOSE_NO_CHARGE,
          note: 'Cliente histórico',
        },
        ADMIN,
        AHORA,
      );
      expect(db.casos[0].status).toBe(RecoveryCaseStatus.CLOSED_NO_CHARGE);
    });

    it('dar de baja pasa por el flujo de envases, en la misma transacción', async () => {
      await service.resolver(
        'case-1',
        DIST,
        { decision: RecoveryDecision.WRITE_OFF, note: 'Perdido' },
        ADMIN,
        AHORA,
      );
      expect(cylinders.retireLost).toHaveBeenCalledWith(
        'cyl-1',
        'Perdido',
        DIST,
        ADMIN,
        db.manager,
      );
      expect(db.casos[0].status).toBe(RecoveryCaseStatus.WRITTEN_OFF);
    });

    it('si el envase ya no está con el cliente, no cierra el caso', async () => {
      cylinders.retireLost.mockRejectedValue(
        new ConflictException('ya volvió'),
      );
      await expect(
        service.resolver(
          'case-1',
          DIST,
          { decision: RecoveryDecision.WRITE_OFF, note: 'x' },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.casos[0].status).toBe(RecoveryCaseStatus.ESCALATED);
    });

    it('un caso perdido (bajo el umbral) también se puede decidir', async () => {
      db.casos[0].status = RecoveryCaseStatus.LOST;
      await service.resolver(
        'case-1',
        DIST,
        { decision: RecoveryDecision.CLOSE_NO_CHARGE, note: 'ok' },
        ADMIN,
        AHORA,
      );
      expect(db.casos[0].status).toBe(RecoveryCaseStatus.CLOSED_NO_CHARGE);
    });

    it('si el envase ya volvió, no decide nada: cierra el caso como devuelto y responde 409', async () => {
      db.envases = [
        unEnvase({
          state: CylinderState.EMPTY_RETURNED,
          currentCustomerId: null,
        }),
      ];
      await expect(
        service.resolver(
          'case-1',
          DIST,
          {
            decision: RecoveryDecision.CHARGE_DEPOSIT,
            note: 'Se cobra el depósito',
          },
          ADMIN,
          AHORA,
        ),
      ).rejects.toThrow(/ya volvió o cambió de manos/);
      expect(db.casos[0].status).toBe(RecoveryCaseStatus.ESCALATED);
      expect(cylinders.retireLost).not.toHaveBeenCalled();
      expect(engine.cerrarPorDevolucion).toHaveBeenCalledWith(
        DIST,
        'cyl-1',
        AHORA,
        false,
      );
    });

    it('si el envase cambió de manos tampoco decide (aunque la decisión sea cerrar sin cargo)', async () => {
      db.envases = [unEnvase({ currentCustomerId: 'otro' })];
      await expect(
        service.resolver(
          'case-1',
          DIST,
          {
            decision: RecoveryDecision.CLOSE_NO_CHARGE,
            note: 'Sin cargo al cliente',
          },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.casos[0].resolvedByUserId).toBeNull();
    });

    it('si el envase se dio de baja por otra vía, el caso se cierra sin cargo', async () => {
      db.envases = [
        unEnvase({ state: CylinderState.RETIRED, currentCustomerId: null }),
      ];
      await expect(
        service.resolver(
          'case-1',
          DIST,
          {
            decision: RecoveryDecision.WRITE_OFF,
            note: 'Perdido por el cliente',
          },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(engine.cerrarPorDevolucion).toHaveBeenCalledWith(
        DIST,
        'cyl-1',
        expect.any(Date),
        true,
      );
    });

    it('un caso que sigue en su secuencia no se resuelve (409)', async () => {
      db.casos[0].status = RecoveryCaseStatus.OPEN;
      await expect(
        service.resolver(
          'case-1',
          DIST,
          { decision: RecoveryDecision.CLOSE_NO_CHARGE, note: 'x' },
          ADMIN,
        ),
      ).rejects.toThrow(/secuencia de avisos/);
    });

    it('un caso ya cerrado no se resuelve dos veces (409)', async () => {
      db.casos[0].status = RecoveryCaseStatus.DEPOSIT_CHARGED;
      await expect(
        service.resolver(
          'case-1',
          DIST,
          { decision: RecoveryDecision.CLOSE_NO_CHARGE, note: 'x' },
          ADMIN,
        ),
      ).rejects.toThrow(/ya está cerrado/);
    });

    it('un caso de otra distribuidora es 404', async () => {
      db.casos = [];
      await expect(
        service.resolver(
          'case-1',
          DIST,
          { decision: RecoveryDecision.CLOSE_NO_CHARGE, note: 'x' },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reporte', () => {
    it('separa perdidos y escalados, suma los importes y lista la revisión manual', async () => {
      casesRepo.find.mockResolvedValue([
        conRelaciones(
          unCaso({
            caseId: 'a',
            status: RecoveryCaseStatus.LOST,
            depositAmount: 26000.1,
            exhaustedAt: AHORA,
          }),
        ),
        conRelaciones(
          unCaso({
            caseId: 'b',
            status: RecoveryCaseStatus.LOST,
            depositAmount: 0.2,
            exhaustedAt: AHORA,
          }),
        ),
        conRelaciones(
          unCaso({
            caseId: 'c',
            status: RecoveryCaseStatus.ESCALATED,
            depositAmount: 70000,
            exhaustedAt: AHORA,
          }),
        ),
      ]);
      db.avisos = [];
      noticesRepo.find.mockResolvedValue([]);
      engine.clasificar.mockReturnValue({
        retenidos: [],
        revisionManual: [
          {
            cylinderId: 'x',
            serial: 'SN-X',
            customerId: null,
            deposit: 1,
            deliveredAt: null,
            motivo: 'sin_cliente',
          },
        ],
      });
      const r = await service.reporte(DIST, AHORA);
      expect(r.lost.map((c) => c.caseId)).toEqual(['a', 'b']);
      expect(r.escalated.map((c) => c.caseId)).toEqual(['c']);
      expect(r.totals).toEqual({
        lostCount: 2,
        lostAmount: 26000.3,
        escalatedCount: 1,
        escalatedAmount: 70000,
        manualReviewCount: 1,
      });
      expect(r.manualReview).toEqual([
        { cylinderId: 'x', serial: 'SN-X', reason: 'sin_cliente' },
      ]);
    });
  });

  describe('parámetros', () => {
    it('muestra los vigentes del proceso', async () => {
      await service.parametrosVigentes(DIST);
      expect(processConfig.vigentes).toHaveBeenCalledWith(
        DIST,
        'cylinder_recovery',
      );
    });

    it('cambia sólo los que vienen y conserva el resto', async () => {
      await service.cambiarParametros(
        DIST,
        { toleranceDays: 45, runHour: undefined },
        ADMIN,
      );
      expect(processConfig.guardar).toHaveBeenCalledWith(
        DIST,
        'cylinder_recovery',
        { ...PARAMETROS, toleranceDays: 45 },
        ADMIN,
      );
      // Serializa los cambios de la misma distribuidora con un lock de la base.
      expect(db.manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`recovery-settings:${DIST}`],
      );
    });
  });

  describe('cliente: responder la oferta de retiro (paso 8)', () => {
    beforeEach(() => {
      db.casos[0].status = RecoveryCaseStatus.OPEN;
      casesRepo.findOneOrFail.mockImplementation(() =>
        Promise.resolve(conRelaciones(db.casos[0])),
      );
      db.avisos = [
        unAviso(),
        unaOferta({ expiresAt: new Date(AHORA.getTime() + DIA) }),
      ];
      orders.findManyForRecovery.mockResolvedValue(
        new Map([['ord-1', unPedido()]]),
      );
      noticesRepo.find.mockImplementation(() => Promise.resolve(db.avisos));
    });

    it('lista sus casos abiertos y escalados', async () => {
      casesRepo.find.mockResolvedValue([conRelaciones(db.casos[0])]);
      const r = await service.delCliente('cust-1', DIST, AHORA);
      expect(r).toHaveLength(1);
      const [{ where }] = casesRepo.find.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where).toEqual(
        expect.objectContaining({ distributorId: DIST, userId: 'cust-1' }),
      );
    });

    it('al aceptar queda asociada al pedido y el caso lo muestra', async () => {
      const r = await service.aceptarRetiro('case-1', 'cust-1', DIST, AHORA);
      const oferta = db.avisos.find(
        (a) => a.kind === RecoveryNoticeKind.PICKUP_OFFER,
      );
      expect(oferta).toEqual(
        expect.objectContaining({
          status: ProposalStatus.ACCEPTED,
          respondedAt: AHORA,
          orderId: 'ord-1',
        }),
      );
      expect(r.pickup).toEqual(
        expect.objectContaining({
          status: ProposalStatus.ACCEPTED,
          orderId: 'ord-1',
          scheduledDate: '2026-11-03',
        }),
      );
    });

    it('al rechazar la oferta se descarta', async () => {
      await service.rechazarRetiro('case-1', 'cust-1', DIST, AHORA);
      const oferta = db.avisos.find(
        (a) => a.kind === RecoveryNoticeKind.PICKUP_OFFER,
      );
      expect(oferta?.status).toBe(ProposalStatus.REJECTED);
      expect(oferta?.respondedAt).toEqual(AHORA);
    });

    it('el caso de otro cliente no existe', async () => {
      db.casos = [];
      await expect(
        service.aceptarRetiro('case-1', 'otro', DIST, AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sin caso abierto es 409', async () => {
      db.casos[0].status = RecoveryCaseStatus.ESCALATED;
      await expect(
        service.aceptarRetiro('case-1', 'cust-1', DIST, AHORA),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin oferta pendiente es 409', async () => {
      db.avisos = [unAviso()];
      await expect(
        service.aceptarRetiro('case-1', 'cust-1', DIST, AHORA),
      ).rejects.toThrow(/No hay una oferta/);
    });

    it('una oferta vencida no se acepta', async () => {
      db.avisos[1].expiresAt = new Date(AHORA.getTime() - 1);
      await expect(
        service.aceptarRetiro('case-1', 'cust-1', DIST, AHORA),
      ).rejects.toThrow(/venció/);
      expect(db.avisos[1].status).toBe(ProposalStatus.PENDING);
    });

    it.each([
      [
        'el pedido ya salió o terminó',
        unPedido({ status: OrderStatus.DELIVERED }),
      ],
      ['el pedido es de otro cliente', unPedido({ customerId: 'otro' })],
    ])('no se acepta si %s', async (_motivo, pedido) => {
      orders.findManyForRecovery.mockResolvedValue(
        new Map([['ord-1', pedido]]),
      );
      await expect(
        service.aceptarRetiro('case-1', 'cust-1', DIST, AHORA),
      ).rejects.toThrow(/ya no admite el retiro/);
    });

    it('rechazar no mira el pedido', async () => {
      orders.findManyForRecovery.mockResolvedValue(new Map());
      await expect(
        service.rechazarRetiro('case-1', 'cust-1', DIST, AHORA),
      ).resolves.toBeDefined();
    });
  });

  describe('chofer', () => {
    let qb: Record<string, jest.Mock>;
    const aceptada = () =>
      unaOferta({ status: ProposalStatus.ACCEPTED, respondedAt: AHORA });

    beforeEach(() => {
      db.casos[0].status = RecoveryCaseStatus.OPEN;
      qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([aceptada()]),
      };
      noticesRepo.createQueryBuilder.mockReturnValue(qb);
      casesRepo.find.mockResolvedValue([conRelaciones(db.casos[0])]);
      orders.findManyForRecovery.mockResolvedValue(
        new Map([
          [
            'ord-1',
            unPedido({ status: OrderStatus.ON_THE_WAY, deliveryId: 'del-1' }),
          ],
        ]),
      );
    });

    it('ve los retiros aceptados en sus pedidos en curso', async () => {
      const r = await service.retirosDelChofer('user-ch', DIST);
      expect(r).toEqual([
        expect.objectContaining({
          orderId: 'ord-1',
          serial: 'SN-001',
          product: '10kg',
          depositAmount: 70000,
          customerName: 'Ana Pérez',
          orderStatus: OrderStatus.ON_THE_WAY,
        }),
      ]);
    });

    it('no ve los de pedidos ajenos ni los que todavía no aceptó el pedido', async () => {
      orders.findManyForRecovery.mockResolvedValue(
        new Map([
          [
            'ord-1',
            unPedido({ status: OrderStatus.PENDING, deliveryId: 'del-1' }),
          ],
        ]),
      );
      expect(await service.retirosDelChofer('user-ch', DIST)).toEqual([]);
      orders.findManyForRecovery.mockResolvedValue(
        new Map([
          [
            'ord-1',
            unPedido({ status: OrderStatus.ACCEPTED, deliveryId: 'otro' }),
          ],
        ]),
      );
      expect(await service.retirosDelChofer('user-ch', DIST)).toEqual([]);
    });

    it('sin retiros acordados o sin ser chofer devuelve vacío', async () => {
      qb.getMany.mockResolvedValue([]);
      expect(await service.retirosDelChofer('user-ch', DIST)).toEqual([]);
      deliveries.buscarPorIdOUsuario.mockResolvedValue(null);
      expect(await service.retirosDelChofer('user-ch', DIST)).toEqual([]);
    });

    describe('confirmar el retiro (paso 9)', () => {
      beforeEach(() => {
        noticesRepo.findOne.mockResolvedValue(
          Object.assign(aceptada(), { recoveryCase: db.casos[0] }),
        );
        casesRepo.findOneOrFail.mockResolvedValue(
          unCaso({ status: RecoveryCaseStatus.RETURNED }),
        );
      });

      it('registra el retorno por la máquina de estados del envase y cierra el caso', async () => {
        const r = await service.confirmarRetiro(
          'n-oferta',
          'user-ch',
          DIST,
          AHORA,
        );
        expect(cylinders.transition).toHaveBeenCalledWith(
          'cyl-1',
          expect.objectContaining({ toState: CylinderState.EMPTY_RETURNED }),
          DIST,
          'user-ch',
        );
        expect(engine.cerrarPorDevolucion).toHaveBeenCalledWith(
          DIST,
          'cyl-1',
          AHORA,
        );
        expect(r).toEqual({
          caseId: 'case-1',
          status: RecoveryCaseStatus.RETURNED,
        });
      });

      it('si el envase ya volvió por otro lado, sólo cierra el caso', async () => {
        cylinders.findOne.mockResolvedValue(
          unEnvase({
            state: CylinderState.EMPTY_RETURNED,
            currentCustomerId: null,
          }),
        );
        await service.confirmarRetiro('n-oferta', 'user-ch', DIST, AHORA);
        expect(cylinders.transition).not.toHaveBeenCalled();
        expect(engine.cerrarPorDevolucion).toHaveBeenCalled();
      });

      it('con el pedido entregado hace menos de 24 horas todavía se confirma el retiro', async () => {
        orders.findManyForRecovery.mockResolvedValue(
          new Map([
            [
              'ord-1',
              unPedido({
                deliveryId: 'del-1',
                status: OrderStatus.DELIVERED,
                deliveredAt: new Date(AHORA.getTime() - 2 * 3_600_000),
              }),
            ],
          ]),
        );
        await service.confirmarRetiro('n-oferta', 'user-ch', DIST, AHORA);
        expect(cylinders.transition).toHaveBeenCalled();
      });

      it('entregado hace más de 24 horas ya no se confirma (403)', async () => {
        orders.findManyForRecovery.mockResolvedValue(
          new Map([
            [
              'ord-1',
              unPedido({
                deliveryId: 'del-1',
                status: OrderStatus.DELIVERED,
                deliveredAt: new Date(AHORA.getTime() - 30 * 3_600_000),
              }),
            ],
          ]),
        );
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST, AHORA),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('un pedido ajeno no existe para el chofer (404)', async () => {
        orders.findManyForRecovery.mockResolvedValue(
          new Map([
            [
              'ord-1',
              unPedido({ deliveryId: 'otro', status: OrderStatus.ON_THE_WAY }),
            ],
          ]),
        );
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('un retiro de otra distribuidora o inexistente es 404', async () => {
        noticesRepo.findOne.mockResolvedValue(null);
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST),
        ).rejects.toBeInstanceOf(NotFoundException);
        noticesRepo.findOne.mockResolvedValue(
          Object.assign(aceptada(), {
            recoveryCase: unCaso({ distributorId: 'otra' }),
          }),
        );
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('si el cliente no aceptó el retiro es 409', async () => {
        noticesRepo.findOne.mockResolvedValue(
          Object.assign(unaOferta(), { recoveryCase: db.casos[0] }),
        );
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST),
        ).rejects.toThrow(/no aceptó/);
      });

      it('si el caso ya cerró es 409', async () => {
        db.casos[0].status = RecoveryCaseStatus.RETURNED;
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST),
        ).rejects.toThrow(/ya está cerrado/);
      });

      it('con el pedido sin aceptar todavía, no se retira (403)', async () => {
        orders.findManyForRecovery.mockResolvedValue(
          new Map([
            [
              'ord-1',
              unPedido({ deliveryId: 'del-1', status: OrderStatus.PENDING }),
            ],
          ]),
        );
        await expect(
          service.confirmarRetiro('n-oferta', 'user-ch', DIST),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('no pude retirar (excepción 8)', () => {
      it('descarta el retiro con el motivo y el caso sigue abierto', async () => {
        const oferta = Object.assign(aceptada(), { recoveryCase: db.casos[0] });
        noticesRepo.findOne.mockResolvedValue(oferta);
        const r = await service.retiroNoRealizado(
          'n-oferta',
          'user-ch',
          DIST,
          'No estaba en casa',
        );
        expect(oferta.status).toBe(ProposalStatus.EXPIRED);
        expect(oferta.responseNote).toBe('No estaba en casa');
        expect(noticesRepo.save).toHaveBeenCalledWith(oferta);
        expect(r).toEqual({
          caseId: 'case-1',
          status: RecoveryCaseStatus.OPEN,
        });
      });
    });
  });
});
