import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CarService } from '../../car/car.service';
import { FleetInsuranceSyncService } from '../../fleet/fleet-insurance-sync.service';
import { InstallmentStatus } from '../domain/insurance.enums';
import { CreateInsurancePolicyDto } from '../dto/insurance-policy.dto';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { Insurer } from '../entities/insurer.entity';
import { InsurancePolicyService } from './insurance-policy.service';

const sincronizada = {
  synced: true,
  pending: false,
  taskId: 't1',
  closedTasks: [{ taskId: 'vieja', status: 'scheduled' }],
  reason: null,
};

describe('InsurancePolicyService', () => {
  let service: InsurancePolicyService;
  let cars: { findOne: jest.Mock };
  let flota: { sincronizar: jest.Mock; revertir: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    exists: jest.Mock;
    findOneOrFail: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    getRepository: jest.Mock;
  };
  let choque: InsurancePolicy | null;
  let dataSourceRef: { transaction: jest.Mock; getRepository: jest.Mock };
  let guardados: unknown[];

  beforeEach(() => {
    guardados = [];
    choque = null;
    cars = { findOne: jest.fn().mockResolvedValue({ typeCar: 'Camioneta' }) };
    flota = {
      sincronizar: jest.fn().mockResolvedValue(sincronizada),
      revertir: jest.fn().mockResolvedValue({ reverted: true, notes: [] }),
    };
    manager = {
      findOne: jest.fn((entidad: unknown) =>
        Promise.resolve(
          entidad === Insurer
            ? { insurerId: 'i1', name: 'Seguros Rivadavia' }
            : null,
        ),
      ),
      exists: jest.fn().mockResolvedValue(true),
      findOneOrFail: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_e: unknown, datos: object) => datos),
      save: jest.fn((x: unknown) => {
        guardados.push(x);
        return Promise.resolve(
          Array.isArray(x) ? x : { ...(x as object), policyId: 'p1' },
        );
      }),
      getRepository: jest.fn(() => ({
        createQueryBuilder: () => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: () => Promise.resolve(choque),
        }),
      })),
    };
    dataSourceRef = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
      getRepository: jest.fn(),
    };
    const dataSource = dataSourceRef;
    service = new InsurancePolicyService(
      dataSource as unknown as DataSource,
      cars as unknown as CarService,
      flota as unknown as FleetInsuranceSyncService,
    );
  });

  const dto = (over: Partial<CreateInsurancePolicyDto> = {}) =>
    ({
      carId: 'c1',
      insurerId: 'i1',
      policyNumber: '67/02/192143',
      coverage: 'Todo riesgo',
      validFrom: '2026-06-22',
      validTo: '2026-12-22',
      paymentCode: '0001',
      installments: { count: 6, amount: 29958, firstDueDate: '2026-06-22' },
      ...over,
    }) as CreateInsurancePolicyDto;

  describe('crear', () => {
    it('guarda la póliza y sus 6 cuotas pendientes con la gracia por omisión', async () => {
      const r = await service.crear(dto(), 'd1');

      expect(r.policyId).toBe('p1');
      const [poliza, cuotas] = guardados as [
        InsurancePolicy,
        InsuranceInstallment[],
      ];
      expect(poliza).toMatchObject({
        distributorId: 'd1',
        carId: 'c1',
        insurerId: 'i1',
        policyNumber: '67/02/192143',
        validFrom: '2026-06-22',
        validTo: '2026-12-22',
        paymentCode: '0001',
        cancelledAt: null,
      });
      expect(cuotas).toHaveLength(6);
      expect(cuotas[0]).toMatchObject({
        distributorId: 'd1',
        policyId: 'p1',
        number: 1,
        total: 6,
        dueDate: '2026-06-22',
        graceUntil: '2026-06-27',
        amount: 29958,
        status: InstallmentStatus.PENDING,
      });
      expect(cuotas[5].dueDate).toBe('2026-11-22');
    });

    it('las cuotas de fin de mes caen el último día del mes', async () => {
      await service.crear(
        dto({
          validFrom: '2026-10-30',
          validTo: '2027-04-30',
          installments: { count: 6, amount: 100, firstDueDate: '2026-10-31' },
        }),
        'd1',
      );
      const cuotas = guardados[1] as InsuranceInstallment[];
      expect(cuotas.map((c) => c.dueDate)).toEqual([
        '2026-10-31',
        '2026-11-30',
        '2026-12-31',
        '2027-01-31',
        '2027-02-28',
        '2027-03-31',
      ]);
    });

    it('deja la tarea de seguro de flota con la vigencia, la prima total y la aseguradora', async () => {
      const r = await service.crear(dto(), 'd1');

      expect(flota.sincronizar).toHaveBeenCalledWith(manager, {
        distributorId: 'd1',
        carId: 'c1',
        typeCar: 'Camioneta',
        validFrom: '2026-06-22',
        validTo: '2026-12-22',
        cost: 179748,
        insurerName: 'Seguros Rivadavia',
        policyNumber: '67/02/192143',
      });
      expect(r.fleet).toEqual({
        synced: true,
        pending: false,
        taskId: 't1',
        reason: null,
      });
    });

    it('la póliza guarda la tarea que creó y las que dio por hechas para poder revertirlas', async () => {
      await service.crear(dto(), 'd1');
      expect(guardados[0]).toMatchObject({
        fleetTaskId: 't1',
        fleetClosedTasks: [{ taskId: 'vieja', status: 'scheduled' }],
        fleetPending: false,
      });
    });

    it('una póliza que empieza después de que vence el seguro actual queda pendiente de sincronizar', async () => {
      flota.sincronizar.mockResolvedValue({
        synced: false,
        pending: true,
        taskId: null,
        closedTasks: [],
        reason: 'cuando empiece',
      });
      const r = await service.crear(dto(), 'd1');
      expect(guardados[0]).toMatchObject({
        fleetTaskId: null,
        fleetClosedTasks: [],
        fleetPending: true,
      });
      expect(r.fleet).toMatchObject({ synced: false, pending: true });
    });

    it('si la flota no tiene plan de seguro la póliza igual se crea y se informa', async () => {
      flota.sincronizar.mockResolvedValue({
        synced: false,
        pending: false,
        taskId: null,
        closedTasks: [],
        reason: 'sin plan',
      });
      const r = await service.crear(dto(), 'd1');
      expect(r.policyId).toBe('p1');
      expect(r.fleet).toEqual({
        synced: false,
        pending: false,
        taskId: null,
        reason: 'sin plan',
      });
    });

    it('un vehículo de otra distribuidora es 404 y no guarda nada', async () => {
      cars.findOne.mockRejectedValue(
        new NotFoundException('Vehículo c1 no encontrado'),
      );
      await expect(service.crear(dto(), 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cars.findOne).toHaveBeenCalledWith('c1', 'd2');
      expect(guardados).toHaveLength(0);
    });

    it('una aseguradora de otra distribuidora es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.crear(dto(), 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(guardados).toHaveLength(0);
    });

    it('un vehículo no tiene dos pólizas con vigencias solapadas (409)', async () => {
      choque = {
        policyNumber: 'VIEJA',
        validFrom: '2026-01-01',
        validTo: '2026-07-01',
      } as InsurancePolicy;
      await expect(service.crear(dto(), 'd1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(guardados).toHaveLength(0);
      expect(flota.sincronizar).not.toHaveBeenCalled();
    });

    it.each([
      ['la póliza vence antes de empezar', { validTo: '2026-06-22' }],
      [
        'la primera cuota vence antes de la póliza',
        {
          installments: { count: 2, amount: 10, firstDueDate: '2026-06-01' },
        },
      ],
      [
        'la última cuota vence después de la póliza',
        {
          installments: { count: 8, amount: 10, firstDueDate: '2026-06-22' },
        },
      ],
    ])('400 si %s', async (_caso, cambio) => {
      await expect(
        service.crear(dto(cambio as Partial<CreateInsurancePolicyDto>), 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(guardados).toHaveLength(0);
    });
  });

  describe('modificar', () => {
    it('cambia el número y la cobertura; la vigencia no se toca', async () => {
      const poliza = {
        policyId: 'p1',
        insurerId: 'i1',
        validFrom: '2026-06-22',
        cancelledAt: null,
      };
      manager.findOne.mockResolvedValue(poliza);
      await service.modificar(
        'p1',
        { policyNumber: 'NUEVO', coverage: 'Terceros' },
        'd1',
      );
      expect(poliza).toMatchObject({
        policyNumber: 'NUEVO',
        coverage: 'Terceros',
        validFrom: '2026-06-22',
      });
    });

    it('una aseguradora de otra distribuidora es 404', async () => {
      manager.findOne.mockResolvedValue({ policyId: 'p1', insurerId: 'i1' });
      manager.exists.mockResolvedValue(false);
      await expect(
        service.modificar('p1', { insurerId: 'otra' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('una póliza cancelada no se modifica (409)', async () => {
      manager.findOne.mockResolvedValue({
        policyId: 'p1',
        cancelledAt: new Date(),
      });
      await expect(
        service.modificar('p1', { coverage: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('una póliza de otra distribuidora es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.modificar('p1', { coverage: 'x' }, 'd2'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancelar', () => {
    const poliza = (over: object = {}) => ({
      policyId: 'p1',
      validTo: '2026-12-22',
      cancelledAt: null,
      cancelReason: null,
      fleetTaskId: 't1',
      fleetClosedTasks: [{ taskId: 'vieja', status: 'in_progress' }],
      fleetPending: false,
      ...over,
    });

    it('cancela con motivo y pasa a canceladas sólo las cuotas pendientes', async () => {
      const p = poliza();
      const cuotas = [
        { status: InstallmentStatus.PENDING },
        { status: InstallmentStatus.PAID },
        { status: InstallmentStatus.PENDING },
      ];
      manager.findOne.mockResolvedValue(p);
      manager.find.mockResolvedValue(cuotas);

      await service.cancelar('p1', { reason: 'Se vendió el vehículo' }, 'd1');

      expect(p.cancelReason).toBe('Se vendió el vehículo');
      expect(p.cancelledAt).toBeInstanceOf(Date);
      expect(cuotas.map((c) => c.status)).toEqual([
        InstallmentStatus.CANCELLED,
        InstallmentStatus.PAID,
        InstallmentStatus.CANCELLED,
      ]);
    });

    it('revierte en la flota, en la misma transacción: cancela la tarea que creó y reabre la anterior', async () => {
      manager.findOne.mockResolvedValue(poliza());
      manager.find.mockResolvedValue([]);

      const r = await service.cancelar('p1', { reason: 'x' }, 'd1');

      expect(flota.revertir).toHaveBeenCalledWith(manager, {
        distributorId: 'd1',
        taskId: 't1',
        closedTasks: [{ taskId: 'vieja', status: 'in_progress' }],
        validTo: '2026-12-22',
      });
      expect(r).toEqual({ reverted: true, notes: [] });
    });

    it('informa lo que no pudo revertir porque alguien lo cambió', async () => {
      manager.findOne.mockResolvedValue(poliza());
      manager.find.mockResolvedValue([]);
      flota.revertir.mockResolvedValue({
        reverted: false,
        notes: ['La tarea de seguro que creó la póliza ya cambió'],
      });
      const r = await service.cancelar('p1', { reason: 'x' }, 'd1');
      expect(r.reverted).toBe(false);
      expect(r.notes).toHaveLength(1);
    });

    it('una póliza que no tocó la flota no la revierte, y una pendiente deja de estarlo', async () => {
      const p = poliza({
        fleetTaskId: null,
        fleetClosedTasks: [],
        fleetPending: true,
      });
      manager.findOne.mockResolvedValue(p);
      manager.find.mockResolvedValue([]);
      await service.cancelar('p1', { reason: 'x' }, 'd1');
      expect(flota.revertir).not.toHaveBeenCalled();
      expect(p.fleetPending).toBe(false);
    });

    it('cancelar dos veces es 409', async () => {
      manager.findOne.mockResolvedValue(poliza({ cancelledAt: new Date() }));
      await expect(
        service.cancelar('p1', { reason: 'otra vez' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(flota.revertir).not.toHaveBeenCalled();
    });

    it('una póliza de otra distribuidora es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.cancelar('p1', { reason: 'x' }, 'd2'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.findOne).toHaveBeenCalledWith(
        InsurancePolicy,
        expect.objectContaining({
          where: { policyId: 'p1', distributorId: 'd2' },
        }),
      );
    });
  });

  describe('completarPendientes', () => {
    let pendientes: Array<{ policyId: string }>;

    beforeEach(() => {
      pendientes = [{ policyId: 'p1' }];
      dataSourceRef.getRepository.mockReturnValue({
        createQueryBuilder: () => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: () => Promise.resolve(pendientes),
        }),
      });
    });

    const nueva = () => ({
      policyId: 'p1',
      carId: 'c1',
      insurerId: 'i1',
      policyNumber: 'N1',
      validFrom: '2026-10-20',
      validTo: '2027-04-20',
      cancelledAt: null,
      fleetPending: true,
      fleetTaskId: null,
      fleetClosedTasks: [],
    });
    let pendiente = nueva();
    beforeEach(() => {
      pendiente = nueva();
    });

    it('sincroniza con la flota la póliza que ya empezó y guarda lo que hizo', async () => {
      manager.findOne.mockResolvedValue(pendiente);
      manager.findOneOrFail.mockResolvedValue({ name: 'Seguros Rivadavia' });
      manager.find.mockResolvedValue([{ amount: 100 }, { amount: 50.5 }]);

      const hechas = await service.completarPendientes('d1', '2026-10-28');

      expect(hechas).toBe(1);
      expect(flota.sincronizar).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ cost: 150.5, validFrom: '2026-10-20' }),
        '2026-10-28',
      );
      expect(pendiente).toMatchObject({
        fleetPending: false,
        fleetTaskId: 't1',
        fleetClosedTasks: [{ taskId: 'vieja', status: 'scheduled' }],
      });
    });

    it('una póliza cancelada entre tanto no se sincroniza', async () => {
      manager.findOne.mockResolvedValue({
        ...pendiente,
        cancelledAt: new Date(),
      });
      expect(await service.completarPendientes('d1', '2026-10-28')).toBe(0);
      expect(flota.sincronizar).not.toHaveBeenCalled();
    });

    it('si una falla, no frena a las demás', async () => {
      pendientes = [{ policyId: 'p1' }, { policyId: 'p2' }];
      manager.findOne
        .mockRejectedValueOnce(new Error('base caída'))
        .mockResolvedValue(pendiente);
      manager.findOneOrFail.mockResolvedValue({ name: 'X' });
      manager.find.mockResolvedValue([{ amount: 1 }]);
      expect(await service.completarPendientes('d1', '2026-10-28')).toBe(1);
    });
  });
});
