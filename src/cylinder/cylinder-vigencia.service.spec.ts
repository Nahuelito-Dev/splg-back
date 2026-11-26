import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { CylinderVigenciaService } from './cylinder-vigencia.service';
import { armarEnvases } from './cylinder-test-kit';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import {
  CylinderInspection,
  CylinderInspectionResult,
} from './entities/cylinder-inspection.entity';
import { RegisterInspectionDto } from './dto/register-inspection.dto';
import { EstadoDeVigencia } from './domain/cylinder-vigencia';
import { diaArgentino, finDelDia, inicioDelDia } from './domain/dia-calendario';

const DIA = 86400000;
const DIST = 'dist-1';

describe('CylinderVigenciaService', () => {
  let service: CylinderVigenciaService;
  let cylinders: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let inspections: { find: jest.Mock };
  let saved: unknown[];
  let lockQb: Record<string, jest.Mock>;
  let listQb: Record<string, jest.Mock>;

  // Reloj fijo al mediodía de Argentina: los días restantes son días de
  // calendario, así que "ahora + 10,5 días" sólo da 11 si el día no se corta.
  const AHORA = new Date('2026-10-15T15:00:00.000Z');
  beforeAll(() =>
    jest.useFakeTimers({
      now: AHORA,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
      ],
    }),
  );
  afterAll(() => jest.useRealTimers());

  const enDias = (n: number) => new Date(Date.now() + n * DIA);
  const dia = (n: number) => diaArgentino(enDias(n));

  const makeCylinder = (over: Partial<Cylinder> = {}): Cylinder =>
    ({
      cylinderId: 'cyl-1',
      distributorId: DIST,
      serial: 'SN-001',
      state: CylinderState.IN_DEPOT,
      manufacturedAt: null,
      lastInspectionAt: null,
      expiresAt: null,
      ...over,
    }) as Cylinder;

  const dto = (over: Partial<RegisterInspectionDto> = {}) =>
    ({
      inspectedAt: dia(-1),
      result: CylinderInspectionResult.APPROVED,
      nextDueAt: dia(365),
      ...over,
    }) as RegisterInspectionDto;

  beforeEach(() => {
    saved = [];
    lockQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    listQb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const save = jest.fn((e: unknown) => {
      saved.push(e);
      return Promise.resolve(e);
    });
    const manager = {
      createQueryBuilder: jest.fn(() => lockQb),
      create: jest.fn((_: unknown, e: unknown) => e),
      save,
      getRepository: jest.fn(() => ({ create: (e: unknown) => e, save })),
    };
    cylinders = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => listQb),
    };
    (cylinders as unknown as { manager: unknown }).manager = {
      transaction: (fn: (m: unknown) => unknown) => fn(manager),
    };
    inspections = { find: jest.fn().mockResolvedValue([]) };
    cylinders.findOne.mockResolvedValue(makeCylinder());

    // El servicio con sus casos de uso y sus adaptadores TypeORM reales.
    ({ vigencia: service } = armarEnvases({
      cylinders: cylinders as unknown as Repository<Cylinder>,
      movements: {} as never,
      inspections: inspections as unknown as Repository<CylinderInspection>,
      orders: {} as never,
      gasCylinders: {} as never,
      eventos: {} as never,
      deliveries: {} as never,
      cuentaDeEnvases: {} as never,
    }));
  });

  describe('registerInspection (CU-132)', () => {
    it('guarda la revisión y copia la última fecha y el vencimiento en la ficha', async () => {
      const cylinder = makeCylinder();
      lockQb.getOne.mockResolvedValue(cylinder);
      const d = dto();

      await service.registerInspection('cyl-1', d, DIST, 'admin-1');

      expect(saved[0]).toMatchObject({
        cylinderId: 'cyl-1',
        distributorId: DIST,
        result: CylinderInspectionResult.APPROVED,
        nextDueAt: finDelDia(dia(365)),
      });
      expect(cylinder.lastInspectionAt).toEqual(inicioDelDia(dia(-1)));
      // Vale hasta las 23:59:59.999 (Buenos Aires) del día de vencimiento.
      expect(cylinder.expiresAt).toEqual(finDelDia(dia(365)));
    });

    it('un rechazo deja el vencimiento en la fecha de la revisión y no guarda próximo vencimiento', async () => {
      const cylinder = makeCylinder();
      lockQb.getOne.mockResolvedValue(cylinder);
      const d = dto({
        result: CylinderInspectionResult.REJECTED,
        nextDueAt: dia(365),
      });

      await service.registerInspection('cyl-1', d, DIST);

      expect(cylinder.expiresAt).toEqual(inicioDelDia(dia(-1)));
      expect(saved[0]).toMatchObject({ nextDueAt: null });
    });

    it('un rechazo sin próximo vencimiento es válido', async () => {
      lockQb.getOne.mockResolvedValue(makeCylinder());
      await expect(
        service.registerInspection(
          'cyl-1',
          dto({
            result: CylinderInspectionResult.REJECTED,
            nextDueAt: undefined,
          }),
          DIST,
        ),
      ).resolves.toBeDefined();
    });

    it('un rechazo anterior a la fabricación del envase es 400 y no guarda nada', async () => {
      lockQb.getOne.mockResolvedValue(
        makeCylinder({ manufacturedAt: enDias(-1) }),
      );
      await expect(
        service.registerInspection(
          'cyl-1',
          dto({
            inspectedAt: dia(-10),
            result: CylinderInspectionResult.REJECTED,
            nextDueAt: undefined,
          }),
          DIST,
        ),
      ).rejects.toThrow('anterior a la fabricación');
      expect(saved).toHaveLength(0);
    });

    it('una revisión APROBADA anterior a la fabricación es 400 aunque el próximo vencimiento sea posterior', async () => {
      lockQb.getOne.mockResolvedValue(
        makeCylinder({ manufacturedAt: enDias(-5) }),
      );
      await expect(
        service.registerInspection(
          'cyl-1',
          dto({ inspectedAt: dia(-10), nextDueAt: dia(365) }),
          DIST,
        ),
      ).rejects.toThrow('anterior a la fabricación');
      expect(saved).toHaveLength(0);
    });

    it('un vencimiento posterior a la fabricación pasa', async () => {
      lockQb.getOne.mockResolvedValue(
        makeCylinder({ manufacturedAt: enDias(-400) }),
      );
      await expect(
        service.registerInspection('cyl-1', dto(), DIST),
      ).resolves.toBeDefined();
    });

    it('rechaza una fecha de revisión futura', async () => {
      await expect(
        service.registerInspection('cyl-1', dto({ inspectedAt: dia(2) }), DIST),
      ).rejects.toThrow(BadRequestException);
      expect(saved).toHaveLength(0);
    });

    it('exige el vencimiento si no es un rechazo', async () => {
      await expect(
        service.registerInspection(
          'cyl-1',
          dto({ nextDueAt: undefined }),
          DIST,
        ),
      ).rejects.toThrow(/obligatoria/);
    });

    it('rechaza un vencimiento que no es posterior a la revisión', async () => {
      const inspectedAt = dia(-5);
      await expect(
        service.registerInspection(
          'cyl-1',
          dto({ inspectedAt, nextDueAt: inspectedAt }),
          DIST,
        ),
      ).rejects.toThrow(/posterior/);
    });

    it('404 si el envase no existe o es de otra distribuidora', async () => {
      lockQb.getOne.mockResolvedValue(null);
      await expect(
        service.registerInspection('cyl-x', dto(), DIST),
      ).rejects.toThrow(NotFoundException);
      expect(lockQb.andWhere).toHaveBeenCalledWith(
        'cylinder.distributorId = :distributorId',
        { distributorId: DIST },
      );
    });

    it('409 si el envase está dado de baja', async () => {
      lockQb.getOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.RETIRED }),
      );
      await expect(
        service.registerInspection('cyl-1', dto(), DIST),
      ).rejects.toThrow(ConflictException);
      expect(saved).toHaveLength(0);
    });

    it('una revisión anterior a la última cargada sólo entra al historial', async () => {
      const ultima = enDias(-10);
      const vencimiento = enDias(300);
      const cylinder = makeCylinder({
        lastInspectionAt: ultima,
        expiresAt: vencimiento,
      });
      lockQb.getOne.mockResolvedValue(cylinder);

      await service.registerInspection(
        'cyl-1',
        dto({ inspectedAt: dia(-400), nextDueAt: dia(-35) }),
        DIST,
      );

      expect(saved).toHaveLength(1);
      expect(cylinder.lastInspectionAt).toBe(ultima);
      expect(cylinder.expiresAt).toBe(vencimiento);
    });

    it('rechazado y en poder de un cliente: no cambia de estado y queda marcado en el historial', async () => {
      const cylinder = makeCylinder({ state: CylinderState.WITH_CUSTOMER });
      lockQb.getOne.mockResolvedValue(cylinder);

      await service.registerInspection(
        'cyl-1',
        dto({ result: CylinderInspectionResult.REJECTED }),
        DIST,
        'admin-1',
      );

      expect(cylinder.state).toBe(CylinderState.WITH_CUSTOMER);
      expect(saved[saved.length - 1]).toMatchObject({
        fromState: CylinderState.WITH_CUSTOMER,
        toState: CylinderState.WITH_CUSTOMER,
        actorUserId: 'admin-1',
        note: expect.stringContaining('retirar') as string,
      });
    });

    it('rechazado en el depósito no deja movimiento', async () => {
      lockQb.getOne.mockResolvedValue(makeCylinder());
      await service.registerInspection(
        'cyl-1',
        dto({ result: CylinderInspectionResult.REJECTED }),
        DIST,
      );
      expect(saved.some((e) => 'toState' in (e as object))).toBe(false);
    });
  });

  describe('getVigencia (CU-133)', () => {
    it('calcula los días y trae el historial', async () => {
      cylinders.findOne.mockResolvedValue(
        makeCylinder({ expiresAt: enDias(10.5) }),
      );
      inspections.find.mockResolvedValue([{ inspectionId: 'i-1' }]);

      const r = await service.getVigencia('cyl-1', DIST);

      expect(r.vigencia).toEqual({
        estado: EstadoDeVigencia.VIGENTE,
        diasRestantes: 11,
      });
      expect(r.inspections).toHaveLength(1);
      expect(r.retiroPendiente).toBe(false);
    });

    it('sin revisión registrada es "sin acreditar", no vencido', async () => {
      const r = await service.getVigencia('cyl-1', DIST);
      expect(r.vigencia.estado).toBe(EstadoDeVigencia.SIN_ACREDITAR);
    });

    it('vencido y afuera queda con retiro pendiente', async () => {
      cylinders.findOne.mockResolvedValue(
        makeCylinder({
          expiresAt: enDias(-2),
          state: CylinderState.WITH_CUSTOMER,
        }),
      );
      const r = await service.getVigencia('cyl-1', DIST);
      expect(r.vigencia.estado).toBe(EstadoDeVigencia.VENCIDO);
      expect(r.retiroPendiente).toBe(true);
    });

    it('404 si no está en la distribuidora, y la consulta se acota a ella', async () => {
      cylinders.findOne.mockResolvedValue(null);
      await expect(service.getVigencia('cyl-x', DIST)).rejects.toThrow(
        NotFoundException,
      );
      expect(cylinders.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { cylinderId: 'cyl-x', distributorId: DIST },
        }),
      );
    });

    it('por serial acota por distribuidora y da 404 si no está', async () => {
      cylinders.findOne.mockResolvedValue(null);
      await expect(service.getVigenciaBySerial('SN-9', DIST)).rejects.toThrow(
        NotFoundException,
      );
      expect(cylinders.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { serial: 'SN-9', distributorId: DIST },
        }),
      );
    });

    it('sin distribuidora en contexto (super admin) no acota', async () => {
      await service.getVigenciaBySerial('SN-001', null);
      expect(cylinders.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { serial: 'SN-001' } }),
      );
    });
  });

  describe('findExpiring (CU-134)', () => {
    /** Cada grupo hace su consulta: vencidos, por vencer y sin revisión, en ese orden. */
    const grupos = (
      expired: Cylinder[],
      expiring: Cylinder[],
      unverified: Cylinder[],
    ) =>
      listQb.getManyAndCount
        .mockResolvedValueOnce([expired, expired.length + 10])
        .mockResolvedValueOnce([expiring, expiring.length])
        .mockResolvedValueOnce([unverified, unverified.length]);

    it('arma los tres grupos con su vigencia y su total sin paginar', async () => {
      grupos(
        [makeCylinder({ serial: 'A', expiresAt: enDias(-5) })],
        [
          makeCylinder({ serial: 'B', expiresAt: enDias(3) }),
          makeCylinder({ serial: 'C', expiresAt: enDias(20) }),
        ],
        [makeCylinder({ serial: 'D', expiresAt: null })],
      );

      const r = await service.findExpiring(30, DIST);

      expect(r.windowDays).toBe(30);
      expect(r.totals).toEqual({ expired: 11, expiring: 2, unverified: 1 });
      expect(r.expired[0].vigencia.estado).toBe(EstadoDeVigencia.VENCIDO);
      expect(r.expiring.map((e) => e.cylinder.serial)).toEqual(['B', 'C']);
      expect(r.unverified[0].vigencia.estado).toBe(
        EstadoDeVigencia.SIN_ACREDITAR,
      );
    });

    it('lista vacía si ninguno cae en la ventana', async () => {
      const r = await service.findExpiring(7, DIST);
      expect(r).toEqual({
        windowDays: 7,
        totals: { expired: 0, expiring: 0, unverified: 0 },
        expired: [],
        expiring: [],
        unverified: [],
      });
    });

    it('pagina cada grupo, acota por distribuidora y excluye las bajas', async () => {
      await service.findExpiring(30, DIST, 25, 50);

      expect(listQb.take).toHaveBeenCalledWith(25);
      expect(listQb.skip).toHaveBeenCalledWith(50);
      expect(listQb.take).toHaveBeenCalledTimes(3);
      expect(listQb.andWhere).toHaveBeenCalledWith(
        'cylinder.distributorId = :distributorId',
        { distributorId: DIST },
      );
      expect(listQb.where).toHaveBeenCalledWith('cylinder.state != :retirado', {
        retirado: CylinderState.RETIRED,
      });
    });

    it('usa la ventana pedida como límite de los por vencer', async () => {
      await service.findExpiring(30, DIST);
      const [, params] = listQb.andWhere.mock.calls[0] as [
        string,
        { limite: Date },
      ];
      expect(Math.round((params.limite.getTime() - Date.now()) / DIA)).toBe(30);
    });

    it('sin distribuidora (super admin) no agrega el filtro', async () => {
      await service.findExpiring(30, null);
      expect(listQb.andWhere).toHaveBeenCalledTimes(3);
    });
  });
});
