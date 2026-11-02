import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { diaArgentino } from '../common/utils/dias-argentina';
import { CoverageZoneService } from './coverage-zone.service';
import { UpdateCoverageZoneDto } from './dto/update-coverage-zone.dto';
import { CoverageZonePricingService } from './coverage-zone-pricing.service';
import {
  CoverageZone,
  CoverageZoneSurchargeType,
} from './entities/coverage-zone.entity';

/**
 * Una zona es un polígono con recargo (fijo o porcentual). Sin zonas
 * cargadas, la distribuidora cubre todo; con zonas, una dirección está
 * cubierta si cae en alguna activa y vigente, y gana la de mayor prioridad (a
 * igual prioridad, la de menor área — eso lo resuelve el ORDER BY de la
 * consulta, no hay forma de testearlo sin PostGIS real: se verifica contra la
 * API en la puesta a punto).
 */
describe('CoverageZoneService', () => {
  let service: CoverageZoneService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    query: jest.Mock;
    findAndCount: jest.Mock;
    findOne: jest.Mock;
    preload: jest.Mock;
    softRemove: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  /** El manager de la transacción en la que corren el alta y la edición. */
  let manager: {
    query: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
    getRepository: jest.Mock;
  };
  /** Zonas activas que ya tiene la distribuidora. */
  let existentes: Array<Partial<CoverageZone>>;
  /** Prioridad máxima de las zonas de la distribuidora (null si no hay). */
  let prioridadMaxima: string | null;

  const pricing = new CoverageZonePricingService();

  beforeEach(() => {
    repo = {
      create: jest.fn((z: Partial<CoverageZone>) => z),
      save: jest.fn((z: CoverageZone) => Promise.resolve(z)),
      count: jest.fn(),
      // Por default, el polígono es válido (no se autointersecta).
      query: jest.fn().mockResolvedValue([{ valid: true, reason: '' }]),
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      preload: jest.fn((z: Partial<CoverageZone>) => z),
      softRemove: jest.fn((z: CoverageZone) => Promise.resolve(z)),
      manager: { transaction: jest.fn() },
    };
    existentes = [];
    prioridadMaxima = null;
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      find: jest.fn(() => Promise.resolve(existentes)),
      create: jest.fn((_entidad: unknown, z: Partial<CoverageZone>) => z),
      save: jest.fn((z: CoverageZone) => Promise.resolve(z)),
      createQueryBuilder: jest.fn(() => {
        const qb = {
          select: jest.fn(),
          where: jest.fn(),
          getRawOne: jest.fn(() => Promise.resolve({ max: prioridadMaxima })),
        };
        qb.select.mockReturnValue(qb);
        qb.where.mockReturnValue(qb);
        return qb;
      }),
      getRepository: jest.fn(() => ({ preload: repo.preload })),
    };
    repo.manager.transaction.mockImplementation(
      (trabajo: (m: EntityManager) => Promise<unknown>) =>
        trabajo(manager as unknown as EntityManager),
    );
    service = new CoverageZoneService(
      repo as unknown as Repository<CoverageZone>,
      pricing,
    );
  });

  const poligono = [
    [-55.9, -27.3],
    [-55.8, -27.3],
    [-55.8, -27.4],
  ];

  describe('create', () => {
    it('cierra el anillo del polígono si viene abierto', async () => {
      const z = await service.create(
        { name: 'Centro', polygon: poligono },
        'd1',
      );
      expect(z.area.coordinates[0]).toHaveLength(4);
      expect(z.area.coordinates[0][3]).toEqual([-55.9, -27.3]);
    });

    it('sin prioridad, la zona nueva queda por encima de las que ya hay', async () => {
      prioridadMaxima = '4';
      const z = await service.create(
        { name: 'Norte', polygon: poligono },
        'd1',
      );
      expect(z.priority).toBe(5);
    });

    it('sin prioridad y sin zonas, arranca en 0', async () => {
      const z = await service.create(
        { name: 'Norte', polygon: poligono },
        'd1',
      );
      expect(z.priority).toBe(0);
    });

    it('serializa las altas de la distribuidora con un lock', async () => {
      await service.create({ name: 'Norte', polygon: poligono }, 'd1');
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        ['coverage_zone:d1'],
      );
    });

    it('el nombre de otra zona activa (sin distinguir mayúsculas) es 409', async () => {
      existentes = [{ coverageZoneId: 'z9', name: 'Centro', priority: 3 }];
      const error = await service
        .create({ name: ' centro ', polygon: poligono, priority: 7 }, 'd1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('«Centro»');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('la prioridad de otra zona activa es 409', async () => {
      existentes = [{ coverageZoneId: 'z9', name: 'Centro', priority: 3 }];
      const error = await service
        .create({ name: 'Norte', polygon: poligono, priority: 3 }, 'd1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('prioridad 3');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('una zona creada inactiva no compite por nombre ni prioridad', async () => {
      existentes = [{ coverageZoneId: 'z9', name: 'Centro', priority: 3 }];
      await expect(
        service.create(
          { name: 'Centro', polygon: poligono, priority: 3, isActive: false },
          'd1',
        ),
      ).resolves.toBeDefined();
    });

    it('rechaza un vértice que no es [lng, lat] numérico', async () => {
      await expect(
        service.create({ name: 'Mal', polygon: [[1, 2], [3], [4, 5]] }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('default: sin surchargeType es percentage', async () => {
      const z = await service.create(
        { name: 'Centro', polygon: poligono, surchargeValue: 10 },
        'd1',
      );
      expect(z.surchargeType).toBe(CoverageZoneSurchargeType.PERCENTAGE);
      expect(z.surchargeValue).toBe(10);
    });

    it('rechaza un porcentaje mayor a 100', async () => {
      await expect(
        service.create(
          {
            name: 'Centro',
            polygon: poligono,
            surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
            surchargeValue: 150,
          },
          'd1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un monto fijo negativo también se rechaza', async () => {
      await expect(
        service.create(
          {
            name: 'Centro',
            polygon: poligono,
            surchargeType: CoverageZoneSurchargeType.FIXED,
            surchargeValue: -5,
          },
          'd1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una zona activa con validUntil ya vencido se rechaza (400)', async () => {
      await expect(
        service.create(
          {
            name: 'Vieja',
            polygon: poligono,
            validUntil: '2020-01-01T00:00:00Z',
          },
          'd1',
        ),
      ).rejects.toThrow('validUntil ya pasó');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('una zona creada inactiva puede tener la fecha de fin pasada', async () => {
      await expect(
        service.create(
          {
            name: 'Vieja',
            polygon: poligono,
            validUntil: '2020-01-01T00:00:00Z',
            isActive: false,
          },
          'd1',
        ),
      ).resolves.toBeDefined();
    });

    it('validUntil antes o igual a validFrom se rechaza', async () => {
      await expect(
        service.create(
          {
            name: 'Centro',
            polygon: poligono,
            validFrom: '2026-10-01T00:00:00Z',
            validUntil: '2026-09-01T00:00:00Z',
          },
          'd1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un día YYYY-MM-DD de vigencia es un día argentino: desde 00:00 ART, hasta 23:59:59.999 ART', async () => {
      const zona = await service.create(
        {
          name: 'Diaria',
          polygon: poligono,
          validFrom: '2099-11-02',
          validUntil: '2099-11-10',
        },
        'd1',
      );
      expect(zona.validFrom?.toISOString()).toBe('2099-11-02T03:00:00.000Z');
      expect(zona.validUntil?.toISOString()).toBe('2099-11-11T02:59:59.999Z');
    });

    it('desde y hasta el mismo día es una zona de un día', async () => {
      await expect(
        service.create(
          {
            name: 'Un día',
            polygon: poligono,
            validFrom: '2099-11-02',
            validUntil: '2099-11-02',
          },
          'd1',
        ),
      ).resolves.toBeDefined();
    });

    it('un hasta de hoy todavía no venció (incluye el día entero)', async () => {
      const hoy = diaArgentino();
      await expect(
        service.create(
          { name: 'Hoy', polygon: poligono, validUntil: hoy },
          'd1',
        ),
      ).resolves.toBeDefined();
    });

    it('una fecha inexistente (2026-02-30) es un 400 y no se guarda', async () => {
      await expect(
        service.create(
          { name: 'Mal', polygon: poligono, validFrom: '2026-02-30' },
          'd1',
        ),
      ).rejects.toThrow('validFrom: no es una fecha válida');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('un instante con hora se respeta tal cual', async () => {
      const zona = await service.create(
        { name: 'Hora', polygon: poligono, validFrom: '2099-11-02T12:00:00Z' },
        'd1',
      );
      expect(zona.validFrom?.toISOString()).toBe('2099-11-02T12:00:00.000Z');
    });

    it('un polígono que se autointersecta se rechaza con el motivo de PostGIS', async () => {
      repo.query.mockResolvedValueOnce([
        { valid: false, reason: 'Self-intersection at or near point 1 2' },
      ]);
      await expect(
        service.create({ name: 'Mal', polygon: poligono }, 'd1'),
      ).rejects.toThrow(/Self-intersection/);
    });
  });

  describe('update', () => {
    it('valida el recargo con el TIPO ya guardado si sólo se manda el valor', async () => {
      repo.findOne.mockResolvedValue({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
        surchargeValue: 10,
        validFrom: null,
        validUntil: null,
      });
      await expect(
        service.update('z1', { surchargeValue: 150 }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un recargo en null se rechaza con 400 en vez de llegar a la base', async () => {
      repo.findOne.mockResolvedValue({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        surchargeType: CoverageZoneSurchargeType.FIXED,
        surchargeValue: 500,
        validFrom: null,
        validUntil: null,
      });
      const conNull = {
        surchargeType: null,
      } as unknown as UpdateCoverageZoneDto;
      await expect(service.update('z1', conNull, 'd1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('de otra distribuidora, no se encuentra (404)', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update('z1', { name: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('zona vencida', () => {
      const vencida = () => ({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        isActive: false,
        surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
        surchargeValue: 10,
        validFrom: null,
        validUntil: new Date('2020-01-01T00:00:00Z'),
      });

      it('reactivar una zona con la fecha de fin pasada se rechaza (400)', async () => {
        repo.findOne.mockResolvedValue(vencida());
        await expect(
          service.update('z1', { isActive: true }, 'd1'),
        ).rejects.toThrow('validUntil ya pasó');
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('reactivarla junto con una fecha de fin futura se acepta', async () => {
        repo.findOne.mockResolvedValue(vencida());
        await expect(
          service.update(
            'z1',
            { isActive: true, validUntil: '2099-01-01T00:00:00Z' },
            'd1',
          ),
        ).resolves.toBeDefined();
      });

      it('renombrar una zona activa que venció (el barrido aún no pasó) no se bloquea', async () => {
        repo.findOne.mockResolvedValue({ ...vencida(), isActive: true });
        await expect(
          service.update('z1', { name: 'Nuevo' }, 'd1'),
        ).resolves.toBeDefined();
      });
    });

    describe('nombre y prioridad entre zonas activas', () => {
      const activa = () => ({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        name: 'Centro',
        priority: 1,
        isActive: true,
        surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
        surchargeValue: 10,
        validFrom: null,
        validUntil: null,
      });

      let guardada: Partial<CoverageZone>;
      /** La zona que hay en la base: la ve `findOne` y `preload` le pone los cambios encima. */
      const enLaBase = (zona: Partial<CoverageZone>) => {
        guardada = zona;
        repo.findOne.mockResolvedValue(zona);
        repo.preload.mockImplementation((cambios: Partial<CoverageZone>) => ({
          ...guardada,
          ...cambios,
        }));
      };

      it('tomar la prioridad de otra zona activa es 409', async () => {
        enLaBase(activa());
        existentes = [
          { coverageZoneId: 'z1', name: 'Centro', priority: 1 },
          { coverageZoneId: 'z2', name: 'Norte', priority: 2 },
        ];
        await expect(
          service.update('z1', { priority: 2 }, 'd1'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('conservar la propia prioridad y nombre no choca consigo misma', async () => {
        enLaBase(activa());
        existentes = [{ coverageZoneId: 'z1', name: 'Centro', priority: 1 }];
        await expect(
          service.update('z1', { color: '#112233' }, 'd1'),
        ).resolves.toBeDefined();
      });

      it('el nombre de otra zona activa es 409', async () => {
        enLaBase(activa());
        existentes = [{ coverageZoneId: 'z2', name: 'Norte', priority: 2 }];
        await expect(
          service.update('z1', { name: 'NORTE' }, 'd1'),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('reactivar una zona con la prioridad ocupada es 409', async () => {
        enLaBase({ ...activa(), isActive: false });
        existentes = [{ coverageZoneId: 'z2', name: 'Norte', priority: 1 }];
        await expect(
          service.update('z1', { isActive: true }, 'd1'),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('desactivar una zona no controla nombre ni prioridad', async () => {
        enLaBase(activa());
        existentes = [{ coverageZoneId: 'z2', name: 'Norte', priority: 1 }];
        await expect(
          service.update('z1', { isActive: false }, 'd1'),
        ).resolves.toBeDefined();
      });
    });

    it('validFrom: null quita la vigencia (NO la convierte en 1970-01-01)', async () => {
      repo.findOne.mockResolvedValue({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
        surchargeValue: 10,
        validFrom: new Date('2026-01-01T00:00:00Z'),
        validUntil: null,
      });
      const zona = await service.update('z1', { validFrom: null }, 'd1');
      expect(zona.validFrom).toBeNull();
    });

    it('al editar, un día YYYY-MM-DD también es un día argentino', async () => {
      repo.findOne.mockResolvedValue({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
        surchargeValue: 10,
        validFrom: null,
        validUntil: null,
      });
      const zona = await service.update(
        'z1',
        { validFrom: '2099-11-02', validUntil: '2099-11-10' },
        'd1',
      );
      expect(zona.validFrom?.toISOString()).toBe('2099-11-02T03:00:00.000Z');
      expect(zona.validUntil?.toISOString()).toBe('2099-11-11T02:59:59.999Z');
    });

    it('validUntil: null quita el vencimiento (NO lo convierte en 1970-01-01)', async () => {
      repo.findOne.mockResolvedValue({
        coverageZoneId: 'z1',
        distributorId: 'd1',
        surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
        surchargeValue: 10,
        validFrom: null,
        validUntil: new Date('2026-12-31T00:00:00Z'),
      });
      const zona = await service.update('z1', { validUntil: null }, 'd1');
      expect(zona.validUntil).toBeNull();
    });
  });

  describe('checkCoverage', () => {
    it('sin zonas cargadas, todo está cubierto sin recargo', async () => {
      repo.count.mockResolvedValue(0);
      await expect(service.checkCoverage('d1', -27, -55)).resolves.toEqual({
        covered: true,
        surcharge: 0,
        zone: null,
      });
      expect(repo.query).not.toHaveBeenCalled();
    });

    it('"nunca definió zonas" cuenta cualquier zona no borrada, activa o no (el conteo no filtra por isActive)', async () => {
      repo.count.mockResolvedValue(1);
      repo.query.mockResolvedValue([]);
      await service.checkCoverage('d1', -27, -55);
      expect(repo.count).toHaveBeenCalledWith({
        where: { distributorId: 'd1' },
      });
    });

    it('con zonas pero ninguna activa y vigente (todas apagadas o vencidas) no cubre nada', async () => {
      repo.count.mockResolvedValue(3);
      repo.query.mockResolvedValue([]);
      await expect(
        service.checkCoverage('d1', -27, -55),
      ).resolves.toMatchObject({ covered: false });
      const [sql] = repo.query.mock.calls[0] as [string];
      expect(sql).toContain('valid_until > now()');
    });

    it('fuera de toda zona activa y vigente, no está cubierto', async () => {
      repo.count.mockResolvedValue(2);
      repo.query.mockResolvedValue([]);
      await expect(service.checkCoverage('d1', -27, -55)).resolves.toEqual({
        covered: false,
        surcharge: 0,
        zone: null,
      });
    });

    it('dentro de una zona fixed, devuelve la zona y su recargo crudo', async () => {
      repo.count.mockResolvedValue(2);
      repo.query.mockResolvedValue([
        {
          coverage_zone_id: 'z1',
          name: 'Posadas',
          surcharge_type: CoverageZoneSurchargeType.FIXED,
          surcharge_value: '500.00',
          color: '#FF7A00',
        },
      ]);
      await expect(service.checkCoverage('d1', -27, -55)).resolves.toEqual({
        covered: true,
        zoneId: 'z1',
        zoneName: 'Posadas',
        surcharge: 500,
        zone: {
          id: 'z1',
          name: 'Posadas',
          type: CoverageZoneSurchargeType.FIXED,
          value: 500,
          color: '#FF7A00',
        },
      });
    });

    it('con subtotal, agrega `amount` con el recargo ya calculado (percentage)', async () => {
      repo.count.mockResolvedValue(1);
      repo.query.mockResolvedValue([
        {
          coverage_zone_id: 'z2',
          name: 'Villa Lanús',
          surcharge_type: CoverageZoneSurchargeType.PERCENTAGE,
          surcharge_value: '10.00',
          color: null,
        },
      ]);
      const resultado = await service.checkCoverage('d1', -27, -55, 10000);
      expect(resultado.amount).toBe(1000);
      expect(resultado.zone?.type).toBe(CoverageZoneSurchargeType.PERCENTAGE);
    });

    it('la consulta filtra activa, no borrada, vigente y ordena por prioridad y área', async () => {
      repo.count.mockResolvedValue(1);
      repo.query.mockResolvedValue([]);
      await service.checkCoverage('d1', -27, -55);

      const [sql] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/"isActive" = true/);
      expect(sql).toMatch(/"deletedAt" IS NULL/);
      expect(sql).toMatch(/valid_from IS NULL OR valid_from <= now\(\)/);
      expect(sql).toMatch(/valid_until IS NULL OR valid_until > now\(\)/);
      expect(sql).toMatch(/ST_Covers\(/);
      expect(sql).toMatch(/ORDER BY priority DESC, ST_Area\(area\) ASC/);
      expect(sql).toMatch(/LIMIT 1/);
    });
  });
});
