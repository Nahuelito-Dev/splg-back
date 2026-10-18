import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { diaArgentino } from '../common/utils/dias-argentina';
import { DriverContextService } from './driver-context.service';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';
import { TrafficFineService } from './traffic-fine.service';

describe('TrafficFineService', () => {
  let service: TrafficFineService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let cars: { findOne: jest.Mock };
  let driver: {
    legajoDelVehiculoEn: jest.Mock;
    assertLegajoDeLaDistribuidora: jest.Mock;
  };
  let actaExistente: number;
  let guardadas: TrafficFine[];

  const base = (over: Partial<TrafficFine> = {}): TrafficFine =>
    ({
      fineId: 'm1',
      distributorId: 'd1',
      carId: 'c1',
      employeeId: 'e1',
      jurisdiction: 'Posadas',
      actNumber: 'A-1',
      amount: 85000,
      voluntaryPaymentAmount: 59500,
      dueDate: '2026-11-15',
      status: TrafficFineStatus.PENDING,
      chargedToEmployee: false,
      alertedAt: new Date(),
      ...over,
    }) as TrafficFine;

  beforeEach(() => {
    actaExistente = 0;
    guardadas = [];
    repo = {
      create: jest.fn((m: Partial<TrafficFine>) => m),
      save: jest.fn((m: TrafficFine) => {
        guardadas.push(m);
        return Promise.resolve({ ...m, fineId: m.fineId ?? 'nueva' });
      }),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn(() => Promise.resolve(actaExistente)),
      })),
    };
    const manager = { getRepository: () => repo };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    cars = { findOne: jest.fn().mockResolvedValue({ carId: 'c1' }) };
    driver = {
      legajoDelVehiculoEn: jest.fn().mockResolvedValue('e1'),
      assertLegajoDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
    };
    service = new TrafficFineService(
      repo as unknown as Repository<TrafficFine>,
      dataSource as unknown as DataSource,
      cars as unknown as CarService,
      driver as unknown as DriverContextService,
    );
  });

  const dto = {
    carId: 'c1',
    occurredAt: '2026-10-10T12:00:00.000Z',
    jurisdiction: 'Posadas',
    actNumber: 'A-1',
    infraction: 'Exceso de velocidad',
    amount: 85000,
  };

  describe('registrar', () => {
    it('nace pendiente y deduce el responsable del vehículo en uso en la infracción', async () => {
      repo.findOne.mockResolvedValue(base());
      await service.registrar(dto, 'd1');
      expect(driver.legajoDelVehiculoEn).toHaveBeenCalledWith(
        'c1',
        'd1',
        new Date(dto.occurredAt),
      );
      expect(guardadas[0]).toMatchObject({
        status: TrafficFineStatus.PENDING,
        employeeId: 'e1',
        distributorId: 'd1',
      });
    });

    it('con un responsable indicado valida que sea de la distribuidora y no deduce', async () => {
      repo.findOne.mockResolvedValue(base());
      await service.registrar({ ...dto, employeeId: 'e9' }, 'd1');
      expect(driver.assertLegajoDeLaDistribuidora).toHaveBeenCalledWith(
        'e9',
        'd1',
      );
      expect(driver.legajoDelVehiculoEn).not.toHaveBeenCalled();
    });

    it('el mismo acta en la misma jurisdicción es 409 «La multa ya está registrada»', async () => {
      actaExistente = 1;
      await expect(service.registrar(dto, 'd1')).rejects.toThrow(
        new ConflictException('La multa ya está registrada'),
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('el pago voluntario no puede superar el importe', async () => {
      await expect(
        service.registrar({ ...dto, voluntaryPaymentAmount: 90000 }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un vehículo ajeno corta antes de todo (404)', async () => {
      cars.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.registrar(dto, 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('transiciones', () => {
    it('pagar: pasa a pagada con la fecha y el importe', async () => {
      repo.findOne.mockResolvedValue(base());
      await service.pagar(
        'm1',
        { paidAt: diaArgentino(), paidAmount: 59500 },
        'd1',
      );
      expect(guardadas[0]).toMatchObject({
        status: TrafficFineStatus.PAID,
        paidAmount: 59500,
      });
    });

    it('pagar con fecha futura es 400 y no toca la base', async () => {
      await expect(
        service.pagar('m1', { paidAt: '2999-01-01', paidAmount: 1 }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it.each([TrafficFineStatus.PAID, TrafficFineStatus.VOIDED])(
      'pagar una multa %s es 409 «La multa no admite el pago»',
      async (status) => {
        repo.findOne.mockResolvedValue(base({ status }));
        await expect(
          service.pagar('m1', { paidAt: diaArgentino(), paidAmount: 1 }, 'd1'),
        ).rejects.toThrow('La multa no admite el pago');
      },
    );

    it('anular: guarda el motivo; una pagada no se anula', async () => {
      repo.findOne.mockResolvedValue(base());
      await service.anular('m1', { reason: 'Error del acta' }, 'd1');
      expect(guardadas[0]).toMatchObject({
        status: TrafficFineStatus.VOIDED,
        voidReason: 'Error del acta',
      });

      repo.findOne.mockResolvedValue(base({ status: TrafficFineStatus.PAID }));
      await expect(
        service.anular('m1', { reason: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('una multa que no es de la distribuidora es 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.anular('m1', { reason: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('imputar: la pagada se imputa, la anulada no, y sin responsable pide uno', async () => {
      repo.findOne.mockResolvedValue(base({ status: TrafficFineStatus.PAID }));
      await service.imputar('m1', {}, 'd1');
      expect(guardadas[0]).toMatchObject({
        chargedToEmployee: true,
        employeeId: 'e1',
      });

      repo.findOne.mockResolvedValue(
        base({ status: TrafficFineStatus.VOIDED }),
      );
      await expect(service.imputar('m1', {}, 'd1')).rejects.toThrow(
        'La multa anulada no se puede imputar',
      );

      repo.findOne.mockResolvedValue(base({ employeeId: null }));
      await expect(service.imputar('m1', {}, 'd1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('imputar a un empleado de otra distribuidora es 404 antes de tocar la multa', async () => {
      driver.assertLegajoDeLaDistribuidora.mockRejectedValue(
        new NotFoundException(),
      );
      await expect(
        service.imputar('m1', { employeeId: 'e9' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('modificar: apelar pasa a apelada y una apelada no se apela de nuevo', async () => {
      repo.findOne.mockResolvedValue(base());
      await service.modificar('m1', { appeal: true }, 'd1');
      expect(guardadas[0].status).toBe(TrafficFineStatus.APPEALED);

      repo.findOne.mockResolvedValue(
        base({ status: TrafficFineStatus.APPEALED }),
      );
      await expect(
        service.modificar('m1', { appeal: true }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('modificar una pagada o anulada es 409', async () => {
      repo.findOne.mockResolvedValue(base({ status: TrafficFineStatus.PAID }));
      await expect(
        service.modificar('m1', { infraction: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('modificar: el acta de otra multa es 409; cambiar el vencimiento la vuelve a avisar', async () => {
      repo.findOne.mockResolvedValue(base());
      actaExistente = 1;
      await expect(
        service.modificar('m1', { actNumber: 'A-2' }, 'd1'),
      ).rejects.toThrow('La multa ya está registrada');

      actaExistente = 0;
      await service.modificar('m1', { dueDate: '2026-12-01' }, 'd1');
      expect(guardadas[0]).toMatchObject({
        dueDate: '2026-12-01',
        alertedAt: null,
      });
    });

    it('modificar: el importe no puede quedar por debajo del pago voluntario', async () => {
      repo.findOne.mockResolvedValue(base());
      await expect(
        service.modificar('m1', { amount: 1000 }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
