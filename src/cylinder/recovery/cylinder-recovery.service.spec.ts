import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { CylinderState } from '../entities/cylinder.entity';
import {
  CylinderRecoveryCase,
  RecoveryCaseStatus,
} from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import { CylinderRecoveryNotifier } from './cylinder-recovery.notifier';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { parametrosDeRecupero } from './domain/recovery-rules';
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

describe('CylinderRecoveryService', () => {
  let db: BaseEnMemoria;
  let casesRepo: {
    save: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    manager: { transaction: jest.Mock; query: jest.Mock };
  };
  let orders: {
    entregasProgramadas: jest.Mock;
    findManyForRecovery: jest.Mock;
  };
  let notifier: {
    porSocket: jest.Mock;
    alClienteAgrupado: jest.Mock;
    escaladoAlAdmin: jest.Mock;
  };
  let processConfig: { obtener: jest.Mock };
  let service: CylinderRecoveryService;
  const P = parametrosDeRecupero(PARAMETROS);

  beforeEach(() => {
    db = new BaseEnMemoria();
    db.envases = [unEnvase()];
    db.casos = [unCaso()];
    casesRepo = {
      save: jest.fn((c: unknown) => Promise.resolve(c)),
      create: jest.fn((c: unknown) => c),
      find: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(db.manager)),
        query: jest.fn(),
      },
    };
    orders = {
      entregasProgramadas: jest.fn().mockResolvedValue([]),
      findManyForRecovery: jest.fn().mockResolvedValue(new Map()),
    };
    notifier = {
      porSocket: jest.fn(),
      alClienteAgrupado: jest.fn().mockResolvedValue(undefined),
      escaladoAlAdmin: jest.fn(),
    };
    processConfig = { obtener: jest.fn().mockResolvedValue(PARAMETROS) };
    service = new CylinderRecoveryService(
      casesRepo as unknown as Repository<CylinderRecoveryCase>,
      {} as Repository<CylinderRecoveryNotice>,
      processConfig as unknown as ProcessConfigService,
      orders as unknown as OrderLookupService,
      notifier as unknown as CylinderRecoveryNotifier,
    );
  });

  describe('clasificar (detección, paso 2)', () => {
    const afuera = (over: object) => ({
      cylinderId: 'c',
      serial: 'SN',
      customerId: 'cust-1' as string | null,
      deposit: 100,
      deliveredAt: new Date(AHORA.getTime() - 40 * DIA) as Date | null,
      ...over,
    });

    it('retiene el envase que pasó la tolerancia y deja el que está en plazo', () => {
      const r = service.clasificar(
        [
          afuera({ serial: 'VIEJO' }),
          afuera({
            serial: 'RECIENTE',
            deliveredAt: new Date(AHORA.getTime() - 5 * DIA),
          }),
        ],
        P,
        AHORA,
      );
      expect(r.retenidos.map((e) => e.serial)).toEqual(['VIEJO']);
      expect(r.revisionManual).toEqual([]);
    });

    it('si no se sabe en poder de quién o desde cuándo, va a revisión manual y no ingresa', () => {
      const r = service.clasificar(
        [
          afuera({ serial: 'SIN-CLIENTE', customerId: null }),
          afuera({ serial: 'SIN-ENTREGA', deliveredAt: null }),
        ],
        P,
        AHORA,
      );
      expect(r.retenidos).toEqual([]);
      expect(r.revisionManual).toEqual([
        expect.objectContaining({
          serial: 'SIN-CLIENTE',
          motivo: 'sin_cliente',
        }),
        expect.objectContaining({
          serial: 'SIN-ENTREGA',
          motivo: 'sin_entrega_registrada',
        }),
      ]);
    });
  });

  describe('envasesAfuera', () => {
    it('lee los envases con cliente de la distribuidora que no tienen caso para esa entrega', async () => {
      casesRepo.manager.query.mockResolvedValue([
        {
          cylinderId: 'c1',
          serial: 'SN-1',
          customerId: 'cust-1',
          deposit: '26000.00',
          deliveredAt: '2026-08-19T19:12:04.000Z',
        },
      ]);
      const r = await service.envasesAfuera(DIST);
      expect(r).toEqual([
        expect.objectContaining({
          deposit: 26000,
          deliveredAt: new Date('2026-08-19T19:12:04.000Z'),
        }),
      ]);
      const [sql, params] = casesRepo.manager.query.mock.calls[0] as [
        string,
        string[],
      ];
      expect(sql).toContain("c.state = 'with_customer'");
      expect(sql).toContain('c.distributor_id = $1');
      expect(sql).toContain("k.status IN ('open', 'escalated', 'lost')");
      expect(params).toEqual([DIST]);
    });
  });

  describe('ejecutar', () => {
    const retenido = {
      cylinderId: 'cyl-1',
      serial: 'SN-001',
      customerId: 'cust-1',
      deposit: 70000,
      deliveredAt: new Date(AHORA.getTime() - 40 * DIA),
    };

    beforeEach(() => {
      casesRepo.manager.query.mockResolvedValue([
        { ...retenido, deposit: '70000.00' },
      ]);
      casesRepo.find.mockResolvedValue([{ caseId: 'case-1' }]);
    });

    it('abre el caso del envase retenido y le manda el recordatorio', async () => {
      const r = await service.ejecutar(DIST, AHORA);
      expect(casesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          distributorId: DIST,
          cylinderId: 'cyl-1',
          userId: 'cust-1',
          depositAmount: 70000,
          step: 1,
          status: RecoveryCaseStatus.OPEN,
        }),
      );
      expect(r).toEqual(
        expect.objectContaining({ abiertos: 1, avisos: 1, revisionManual: 0 }),
      );
      expect(notifier.porSocket).toHaveBeenCalledTimes(1);
      expect(notifier.alClienteAgrupado).toHaveBeenCalledTimes(1);
    });

    it('con el recupero apagado no hace nada y avisa con un 409', async () => {
      processConfig.obtener.mockResolvedValue({ ...PARAMETROS, enabled: 0 });
      await expect(service.ejecutar(DIST, AHORA)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(casesRepo.manager.query).not.toHaveBeenCalled();
      expect(casesRepo.save).not.toHaveBeenCalled();
      expect(notifier.alClienteAgrupado).not.toHaveBeenCalled();
    });

    it('primera corrida con varios envases de un mismo cliente: UN solo push que los agrupa', async () => {
      casesRepo.manager.query.mockResolvedValue(
        [1, 2, 3].map((n) => ({
          ...retenido,
          cylinderId: `cyl-${n}`,
          serial: `SN-00${n}`,
          deposit: '70000.00',
        })),
      );
      casesRepo.find.mockResolvedValue([
        { caseId: 'a' },
        { caseId: 'b' },
        { caseId: 'c' },
      ]);
      jest.spyOn(service, 'procesarCaso').mockImplementation((caseId) =>
        Promise.resolve({
          avisos: [
            {
              aviso: unAviso({ noticeId: `n-${caseId}` }),
              ctx: { serial: `SN-${caseId}`, diasAfuera: 40 },
            },
            {
              aviso: unaOferta({ noticeId: `o-${caseId}` }),
              ctx: { serial: `SN-${caseId}`, diasAfuera: 40 },
            },
          ],
          ofertas: 1,
          estado: RecoveryCaseStatus.OPEN,
          caso: unCaso({ caseId, userId: 'cust-1' }),
          ctx: { serial: `SN-${caseId}`, diasAfuera: 40 },
        }),
      );
      await service.ejecutar(DIST, AHORA);
      expect(notifier.porSocket).toHaveBeenCalledTimes(6);
      expect(notifier.alClienteAgrupado).toHaveBeenCalledTimes(1);
      const [userId, avisos] = notifier.alClienteAgrupado.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(userId).toBe('cust-1');
      expect(avisos).toHaveLength(6);
    });

    it('también recorre los casos escalados y perdidos', async () => {
      await service.ejecutar(DIST, AHORA);
      const [{ where }] = casesRepo.find.mock.calls[0] as [
        { where: { status: { _value: string[] } } },
      ];
      expect(where.status._value).toEqual([
        RecoveryCaseStatus.OPEN,
        RecoveryCaseStatus.ESCALATED,
        RecoveryCaseStatus.LOST,
      ]);
    });

    it('si otra corrida abrió el caso primero (único en la base) lo retoma sin duplicar', async () => {
      casesRepo.save.mockRejectedValue({ code: '23505' });
      const r = await service.ejecutar(DIST, AHORA);
      expect(r.abiertos).toBe(0);
    });

    it('un error al abrir un caso no frena a los demás ni se propaga', async () => {
      casesRepo.save.mockRejectedValue(new Error('base caída'));
      await expect(service.ejecutar(DIST, AHORA)).resolves.toEqual(
        expect.objectContaining({ abiertos: 0 }),
      );
    });

    it('cuenta los envases para revisión manual y no les abre caso', async () => {
      casesRepo.manager.query.mockResolvedValue([
        { ...retenido, customerId: null, deposit: '10' },
      ]);
      casesRepo.find.mockResolvedValue([]);
      const r = await service.ejecutar(DIST, AHORA);
      expect(r.revisionManual).toBe(1);
      expect(casesRepo.save).not.toHaveBeenCalled();
    });

    it('un caso que falla no frena al resto', async () => {
      casesRepo.find.mockResolvedValue([
        { caseId: 'rompe' },
        { caseId: 'case-1' },
      ]);
      casesRepo.manager.transaction
        .mockRejectedValueOnce(new Error('deadlock'))
        .mockImplementation((fn: (m: unknown) => unknown) => fn(db.manager));
      const r = await service.ejecutar(DIST, AHORA);
      expect(r.avisos).toBe(1);
    });

    it('cuenta devueltos, escalados y perdidos de la pasada', async () => {
      casesRepo.find.mockResolvedValue([
        { caseId: 'a' },
        { caseId: 'b' },
        { caseId: 'c' },
      ]);
      const procesar = jest
        .spyOn(service, 'procesarCaso')
        .mockResolvedValueOnce({
          avisos: [],
          ofertas: 0,
          estado: RecoveryCaseStatus.RETURNED,
          caso: unCaso(),
          ctx: null,
        })
        .mockResolvedValueOnce({
          avisos: [],
          ofertas: 0,
          estado: RecoveryCaseStatus.ESCALATED,
          caso: unCaso(),
          ctx: { serial: 'S', diasAfuera: 1 },
        })
        .mockResolvedValueOnce({
          avisos: [],
          ofertas: 0,
          estado: RecoveryCaseStatus.LOST,
          caso: unCaso(),
          ctx: { serial: 'S', diasAfuera: 1 },
        });
      const r = await service.ejecutar(DIST, AHORA);
      expect(procesar).toHaveBeenCalledTimes(3);
      expect(r).toEqual(
        expect.objectContaining({
          cerradosPorDevolucion: 1,
          escalados: 1,
          perdidos: 1,
        }),
      );
      expect(notifier.escaladoAlAdmin).toHaveBeenCalledTimes(1);
    });
  });

  describe('procesarCaso', () => {
    const procesar = () => service.procesarCaso('case-1', P, AHORA);

    it('un caso que ya no está abierto no se toca', async () => {
      db.casos = [unCaso({ status: RecoveryCaseStatus.ESCALATED })];
      expect(await procesar()).toBeNull();
      expect(db.avisos).toEqual([]);
    });

    describe('casos escalados y perdidos', () => {
      it.each([RecoveryCaseStatus.ESCALATED, RecoveryCaseStatus.LOST])(
        'un caso %s cuyo envase volvió se cierra como devuelto',
        async (status) => {
          db.casos = [unCaso({ status, step: 3, exhaustedAt: AHORA })];
          db.envases = [
            unEnvase({
              state: CylinderState.EMPTY_RETURNED,
              currentCustomerId: null,
            }),
          ];
          const r = await procesar();
          expect(r?.estado).toBe(RecoveryCaseStatus.RETURNED);
          expect(db.casos[0].closedAt).toEqual(AHORA);
        },
      );

      it('si el envase cambió de manos también se cierra', async () => {
        db.casos = [
          unCaso({ status: RecoveryCaseStatus.ESCALATED, exhaustedAt: AHORA }),
        ];
        db.envases = [unEnvase({ currentCustomerId: 'otro' })];
        expect((await procesar())?.estado).toBe(RecoveryCaseStatus.RETURNED);
      });

      it('si sigue con el cliente no se toca: espera la decisión', async () => {
        db.casos = [
          unCaso({ status: RecoveryCaseStatus.LOST, exhaustedAt: AHORA }),
        ];
        expect(await procesar()).toBeNull();
        expect(db.avisos).toEqual([]);
        expect(db.casos[0].status).toBe(RecoveryCaseStatus.LOST);
      });
    });

    describe('paso 4: se relee el envase antes de cada escalón', () => {
      it('si volvió, cierra el caso como devuelto sin más gestión', async () => {
        db.envases = [
          unEnvase({
            state: CylinderState.EMPTY_RETURNED,
            currentCustomerId: null,
          }),
        ];
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.RETURNED);
        expect(db.casos[0]).toEqual(
          expect.objectContaining({
            status: RecoveryCaseStatus.RETURNED,
            closedAt: AHORA,
          }),
        );
        expect(db.avisos).toEqual([]);
      });

      it('si ahora lo tiene otro cliente, el caso viejo se cierra como devuelto', async () => {
        db.envases = [unEnvase({ currentCustomerId: 'otro' })];
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.RETURNED);
      });

      it('si se dio de baja por otra vía, cierra sin cargo con la nota del porqué', async () => {
        db.envases = [
          unEnvase({ state: CylinderState.RETIRED, currentCustomerId: null }),
        ];
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.CLOSED_NO_CHARGE);
        expect(db.casos[0].resolutionNote).toMatch(/baja/);
      });

      it('al cerrar vence la oferta de retiro que nadie contestó', async () => {
        db.envases = [
          unEnvase({
            state: CylinderState.EMPTY_RETURNED,
            currentCustomerId: null,
          }),
        ];
        await procesar();
        expect(db.actualizaciones).toEqual([
          { status: ProposalStatus.EXPIRED },
        ]);
      });
    });

    describe('escalones (pasos 5, 7 y 10)', () => {
      it('caso nuevo: manda el recordatorio y fija el vencimiento del escalón', async () => {
        const r = await procesar();
        expect(db.avisos).toHaveLength(1);
        expect(db.avisos[0]).toEqual(
          expect.objectContaining({
            kind: RecoveryNoticeKind.REMINDER,
            step: 1,
            status: null,
          }),
        );
        expect(db.casos[0].stepDueAt).toEqual(
          new Date(AHORA.getTime() + 7 * DIA),
        );
        expect(r?.avisos).toHaveLength(1);
        expect(r?.ctx).toEqual(
          expect.objectContaining({ serial: 'SN-001', diasAfuera: 40 }),
        );
      });

      it('dos pasadas seguidas no repiten el aviso (idempotente)', async () => {
        await procesar();
        const segunda = await procesar();
        expect(db.avisos).toHaveLength(1);
        expect(segunda?.avisos).toEqual([]);
      });

      it('vencido el primer escalón sube al segundo con el aviso del depósito', async () => {
        await procesar();
        const despues = new Date(AHORA.getTime() + 8 * DIA);
        const r = await service.procesarCaso('case-1', P, despues);
        expect(db.casos[0].step).toBe(2);
        expect(db.avisos.map((a) => a.kind)).toEqual([
          RecoveryNoticeKind.REMINDER,
          RecoveryNoticeKind.DEPOSIT_WARNING,
        ]);
        expect(r?.estado).toBe(RecoveryCaseStatus.OPEN);
      });

      it('agotados los escalones con un depósito sobre el umbral, escala con el cliente a la vista', async () => {
        db.casos = [unCaso({ step: 2, depositAmount: 70000 })];
        db.avisos = [
          unAviso({ step: 2, kind: RecoveryNoticeKind.DEPOSIT_WARNING }),
        ];
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - 1);
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.ESCALATED);
        expect(db.casos[0]).toEqual(
          expect.objectContaining({
            status: RecoveryCaseStatus.ESCALATED,
            step: 3,
            exhaustedAt: AHORA,
            closedAt: null,
          }),
        );
        expect(r?.ctx?.customerName).toBe('Ana Pérez');
      });

      it('agotados los escalones con un depósito bajo el umbral, queda como envase perdido', async () => {
        db.casos = [unCaso({ step: 2, depositAmount: 26000 })];
        db.avisos = [
          unAviso({ step: 2, kind: RecoveryNoticeKind.DEPOSIT_WARNING }),
        ];
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - 1);
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.LOST);
        expect(db.casos[0].status).toBe(RecoveryCaseStatus.LOST);
        expect(db.casos[0].exhaustedAt).toEqual(AHORA);
      });

      it('con el depósito justo en el umbral no escala', async () => {
        db.casos = [unCaso({ step: 2, depositAmount: 50000 })];
        db.avisos = [
          unAviso({ step: 2, kind: RecoveryNoticeKind.DEPOSIT_WARNING }),
        ];
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - 1);
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.LOST);
      });
    });

    describe('oferta de retiro en la próxima entrega (pasos 6 y 8)', () => {
      it('con una entrega programada en la ventana la ofrece con la vigencia configurada', async () => {
        orders.entregasProgramadas.mockResolvedValue([
          {
            orderId: 'ord-1',
            scheduledDate: '2026-11-03',
            status: OrderStatus.PENDING,
            deliveryId: null,
          },
        ]);
        const r = await procesar();
        const oferta = db.avisos.find(
          (a) => a.kind === RecoveryNoticeKind.PICKUP_OFFER,
        );
        expect(oferta).toEqual(
          expect.objectContaining({
            orderId: 'ord-1',
            status: ProposalStatus.PENDING,
            expiresAt: new Date(AHORA.getTime() + 72 * 60 * 60 * 1000),
          }),
        );
        expect(r?.ofertas).toBe(1);
        expect(r?.avisos.map((a) => a.ctx.entregaProgramada)).toContain(
          '2026-11-03',
        );
        expect(orders.entregasProgramadas).toHaveBeenCalledWith(
          'cust-1',
          DIST,
          '2026-10-31',
          '2026-11-07',
        );
      });

      it('sin entrega programada el escalón de oferta se saltea y la secuencia sigue', async () => {
        const r = await procesar();
        expect(r?.ofertas).toBe(0);
        expect(db.avisos.map((a) => a.kind)).toEqual([
          RecoveryNoticeKind.REMINDER,
        ]);
      });

      it('no repite la oferta mientras haya una vigente', async () => {
        orders.entregasProgramadas.mockResolvedValue([
          {
            orderId: 'ord-2',
            scheduledDate: '2026-11-04',
            status: OrderStatus.PENDING,
            deliveryId: null,
          },
        ]);
        db.avisos = [
          unAviso(),
          unaOferta({ expiresAt: new Date(AHORA.getTime() + DIA) }),
        ];
        orders.findManyForRecovery.mockResolvedValue(
          new Map([['ord-1', unPedido()]]),
        );
        const r = await procesar();
        expect(r?.ofertas).toBe(0);
      });

      it('no vuelve a ofrecer el mismo pedido que ya se ofreció', async () => {
        orders.entregasProgramadas.mockResolvedValue([
          {
            orderId: 'ord-1',
            scheduledDate: '2026-11-03',
            status: OrderStatus.PENDING,
            deliveryId: null,
          },
        ]);
        db.avisos = [
          unAviso(),
          unaOferta({ status: ProposalStatus.REJECTED, respondedAt: AHORA }),
        ];
        const r = await procesar();
        expect(r?.ofertas).toBe(0);
      });

      it('una oferta que nadie contestó y venció pasa a vencida', async () => {
        const oferta = unaOferta({ expiresAt: new Date(AHORA.getTime() - 1) });
        db.avisos = [unAviso(), oferta];
        orders.findManyForRecovery.mockResolvedValue(
          new Map([['ord-1', unPedido()]]),
        );
        await procesar();
        expect(oferta.status).toBe(ProposalStatus.EXPIRED);
      });

      it('con el retiro aceptado en un pedido que sigue en pie, el caso espera aunque venza el escalón', async () => {
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - DIA);
        db.avisos = [
          unAviso(),
          unaOferta({ status: ProposalStatus.ACCEPTED, respondedAt: AHORA }),
        ];
        orders.findManyForRecovery.mockResolvedValue(
          new Map([['ord-1', unPedido({ status: OrderStatus.ACCEPTED })]]),
        );
        const r = await procesar();
        expect(r?.estado).toBe(RecoveryCaseStatus.OPEN);
        expect(db.casos[0].step).toBe(1);
        expect(db.avisos).toHaveLength(2);
      });

      it('el pedido entregado hace menos de 24 horas todavía deja confirmar el retiro: el caso espera', async () => {
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - DIA);
        db.avisos = [
          unAviso(),
          unaOferta({ status: ProposalStatus.ACCEPTED, respondedAt: AHORA }),
        ];
        orders.findManyForRecovery.mockResolvedValue(
          new Map([
            [
              'ord-1',
              unPedido({
                status: OrderStatus.DELIVERED,
                deliveredAt: new Date(AHORA.getTime() - 3 * 60 * 60 * 1000),
              }),
            ],
          ]),
        );
        await procesar();
        expect(db.avisos[1].status).toBe(ProposalStatus.ACCEPTED);
        expect(db.casos[0].step).toBe(1);
      });

      it('pasadas las 24 horas de la entrega sin retiro, la oferta vence y el caso sigue', async () => {
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - DIA);
        db.avisos = [
          unAviso(),
          unaOferta({ status: ProposalStatus.ACCEPTED, respondedAt: AHORA }),
        ];
        orders.findManyForRecovery.mockResolvedValue(
          new Map([
            [
              'ord-1',
              unPedido({
                status: OrderStatus.DELIVERED,
                deliveredAt: new Date(AHORA.getTime() - 25 * 60 * 60 * 1000),
              }),
            ],
          ]),
        );
        await procesar();
        expect(db.avisos[1].status).toBe(ProposalStatus.EXPIRED);
        expect(db.casos[0].step).toBe(2);
      });

      it('si el chofer no logró retirarlo, el caso vuelve a su escalón y la secuencia continúa', async () => {
        const oferta = unaOferta({
          status: ProposalStatus.ACCEPTED,
          respondedAt: AHORA,
        });
        db.casos[0].stepDueAt = new Date(AHORA.getTime() - DIA);
        db.avisos = [unAviso(), oferta];
        orders.findManyForRecovery.mockResolvedValue(
          new Map([['ord-1', unPedido({ status: OrderStatus.DELIVERED })]]),
        );
        const r = await procesar();
        expect(oferta.status).toBe(ProposalStatus.EXPIRED);
        expect(oferta.responseNote).toMatch(/sin que el chofer/);
        expect(db.casos[0].step).toBe(2);
        expect(r?.avisos.map((a) => a.aviso.kind)).toContain(
          RecoveryNoticeKind.DEPOSIT_WARNING,
        );
      });
    });
  });

  describe('cerrarPorDevolucion (paso 9)', () => {
    it('cierra el caso vivo del envase como devuelto', async () => {
      db.casos = [
        unCaso({ status: RecoveryCaseStatus.ESCALATED, exhaustedAt: AHORA }),
      ];
      expect(await service.cerrarPorDevolucion(DIST, 'cyl-1', AHORA)).toBe(
        true,
      );
      expect(db.casos[0]).toEqual(
        expect.objectContaining({
          status: RecoveryCaseStatus.RETURNED,
          closedAt: AHORA,
        }),
      );
    });

    it('sin caso vivo no hace nada (idempotente)', async () => {
      db.casos = [];
      expect(await service.cerrarPorDevolucion(DIST, 'cyl-1', AHORA)).toBe(
        false,
      );
    });
  });

  describe('distribuidorasConEnvasesAfuera y parametros', () => {
    it('devuelve los ids de las distribuidoras con envases afuera o casos abiertos', async () => {
      casesRepo.manager.query.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
      expect(await service.distribuidorasConEnvasesAfuera()).toEqual([
        'd1',
        'd2',
      ]);
    });

    it('lee los parámetros de la distribuidora', async () => {
      expect(await service.parametros(DIST)).toEqual(P);
      expect(processConfig.obtener).toHaveBeenCalledWith(
        DIST,
        'cylinder_recovery',
      );
    });
  });
});
