import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { FleetStatus } from '../car/entities/car.entity';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DriverContextService } from './driver-context.service';
import {
  VehicleAccident,
  VehicleAccidentStatus,
} from './entities/vehicle-accident.entity';
import {
  EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE,
  EVENTO_SINIESTRO_CON_DERRAME,
} from './events/fleet-expense.events';
import { VehicleAccidentService } from './vehicle-accident.service';

describe('VehicleAccidentService', () => {
  let service: VehicleAccidentService;
  let repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let cars: {
    findOne: jest.Mock;
    bloquear: jest.Mock;
    cambiarEstadoDeFlota: jest.Mock;
  };
  let assignments: { liberarDelVehiculo: jest.Mock };
  let driver: {
    vehiculoEnUso: jest.Mock;
    legajoDe: jest.Mock;
    legajoDelVehiculoEn: jest.Mock;
    assertLegajoDeLaDistribuidora: jest.Mock;
  };
  let eventos: { emit: jest.Mock };
  let guardados: VehicleAccident[];

  const dto = {
    carId: 'c1',
    occurredAt: '2026-10-10T12:00:00.000Z',
    description: 'Choque',
  };
  const guardado = (over: Partial<VehicleAccident> = {}) =>
    ({
      accidentId: 's1',
      distributorId: 'd1',
      status: VehicleAccidentStatus.REPORTED,
      ...over,
    }) as VehicleAccident;

  beforeEach(() => {
    guardados = [];
    repo = {
      create: jest.fn((s: Partial<VehicleAccident>) => s),
      save: jest.fn((s: VehicleAccident) => {
        guardados.push(s);
        return Promise.resolve({ ...s, accidentId: s.accidentId ?? 's1' });
      }),
      findOne: jest.fn().mockResolvedValue(guardado()),
    };
    const manager = { getRepository: () => repo };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    cars = {
      findOne: jest.fn().mockResolvedValue({ carId: 'c1' }),
      bloquear: jest
        .fn()
        .mockResolvedValue({ carId: 'c1', fleetStatus: FleetStatus.ACTIVE }),
      cambiarEstadoDeFlota: jest.fn().mockResolvedValue(undefined),
    };
    assignments = {
      liberarDelVehiculo: jest.fn().mockResolvedValue({
        deliveryId: 'dl1',
        liberada: true,
        motivoSiSeMantiene: null,
      }),
    };
    driver = {
      vehiculoEnUso: jest.fn().mockResolvedValue('c1'),
      legajoDe: jest.fn().mockResolvedValue('e1'),
      legajoDelVehiculoEn: jest.fn().mockResolvedValue('e1'),
      assertLegajoDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
    };
    eventos = { emit: jest.fn() };
    service = new VehicleAccidentService(
      repo as unknown as Repository<VehicleAccident>,
      dataSource as unknown as DataSource,
      cars as unknown as CarService,
      assignments as unknown as VehicleAssignmentService,
      driver as unknown as DriverContextService,
      eventos as unknown as EventEmitter2,
    );
  });

  describe('registrar', () => {
    it('nace denunciado y, si no quedó inutilizable, no toca el vehículo ni su asignación', async () => {
      await service.registrar(dto, 'd1', 'u1');
      expect(guardados[0]).toMatchObject({
        status: VehicleAccidentStatus.REPORTED,
        vehicleUnusable: false,
        employeeId: 'e1',
        createdByUserId: 'u1',
      });
      expect(cars.cambiarEstadoDeFlota).not.toHaveBeenCalled();
      expect(assignments.liberarDelVehiculo).not.toHaveBeenCalled();
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('inutilizable: pasa el vehículo a fuera de servicio y libera a su chofer, en la misma transacción', async () => {
      await service.registrar({ ...dto, vehicleUnusable: true }, 'd1', 'u1');
      expect(cars.cambiarEstadoDeFlota).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        'd1',
        FleetStatus.GROUNDED,
      );
      expect(assignments.liberarDelVehiculo).toHaveBeenCalledWith(
        'c1',
        expect.anything(),
        expect.objectContaining({ actorUserId: 'u1' }),
      );
    });

    it('un vehículo ya fuera de servicio no se vuelve a pasar, pero se libera igual', async () => {
      cars.bloquear.mockResolvedValue({
        carId: 'c1',
        fleetStatus: FleetStatus.GROUNDED,
      });
      await service.registrar({ ...dto, vehicleUnusable: true }, 'd1', 'u1');
      expect(cars.cambiarEstadoDeFlota).not.toHaveBeenCalled();
      expect(assignments.liberarDelVehiculo).toHaveBeenCalled();
    });

    it('inutilizable sin pedido en curso: se libera y el resultado no marca asignación mantenida', async () => {
      const r = await service.registrar(
        { ...dto, vehicleUnusable: true },
        'd1',
        'u1',
      );
      expect(r).toMatchObject({
        assignmentKept: false,
        assignmentKeptReason: null,
      });
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('inutilizable con pedido en curso o carga abierta: el siniestro SE REGISTRA, el vehículo sale de servicio, la asignación se mantiene y se avisa a los administradores', async () => {
      assignments.liberarDelVehiculo.mockResolvedValue({
        deliveryId: 'dl1',
        liberada: false,
        motivoSiSeMantiene: 'su chofer tiene un pedido en curso',
      });
      const r = await service.registrar(
        { ...dto, vehicleUnusable: true, hazmatRelease: true },
        'd1',
        'u1',
      );
      expect(guardados).toHaveLength(1);
      expect(cars.cambiarEstadoDeFlota).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        'd1',
        FleetStatus.GROUNDED,
      );
      expect(r).toMatchObject({
        assignmentKept: true,
        assignmentKeptReason: 'su chofer tiene un pedido en curso',
      });
      // el aviso del derrame sale igual, y además el de la asignación pendiente
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_SINIESTRO_CON_DERRAME,
        expect.anything(),
      );
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE,
        expect.objectContaining({
          motivo: 'su chofer tiene un pedido en curso',
        }),
      );
    });

    it('el derrame de gas publica el evento de aviso inmediato', async () => {
      await service.registrar({ ...dto, hazmatRelease: true }, 'd1', 'u1');
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_SINIESTRO_CON_DERRAME,
        expect.objectContaining({ distributorId: 'd1', carId: 'c1' }),
      );
    });

    it('un punto inválido es 400 y no se guarda nada', async () => {
      await expect(
        service.registrar({ ...dto, location: '95,200' }, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('un siniestro futuro es 400', async () => {
      await expect(
        service.registrar(
          { ...dto, occurredAt: '2999-01-01T00:00:00.000Z' },
          'd1',
          'u1',
        ),
      ).rejects.toThrow('Fecha del hecho: el siniestro no puede ser futuro');
    });

    it('un vehículo de otra distribuidora es 404', async () => {
      cars.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.registrar(dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('el chofer registra el de su vehículo en uso, con su propio legajo', async () => {
      const { carId: _omitido, ...sinVehiculo } = dto;
      void _omitido;
      await service.registrarPropio(sinVehiculo, 'd1', 'u1');
      expect(driver.vehiculoEnUso).toHaveBeenCalledWith('u1', 'd1');
      expect(guardados[0]).toMatchObject({ carId: 'c1', employeeId: 'e1' });
    });

    it('el chofer sin vehículo en uso no registra nada', async () => {
      driver.vehiculoEnUso.mockRejectedValue(
        new NotFoundException('No tenés un vehículo en uso'),
      );
      const { carId: _omitido, ...sinVehiculo } = dto;
      void _omitido;
      await expect(
        service.registrarPropio(sinVehiculo, 'd1', 'u1'),
      ).rejects.toThrow('No tenés un vehículo en uso');
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('modificar', () => {
    it('avanza al estado siguiente del ciclo', async () => {
      await service.modificar(
        's1',
        { status: VehicleAccidentStatus.UNDER_REVIEW },
        'd1',
      );
      expect(guardados[0].status).toBe(VehicleAccidentStatus.UNDER_REVIEW);
    });

    it('un salto de estado es 409', async () => {
      await expect(
        service.modificar(
          's1',
          { status: VehicleAccidentStatus.REPAIRING },
          'd1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('pasar hazmatRelease de false a true emite el aviso de derrame', async () => {
      await service.modificar('s1', { hazmatRelease: true }, 'd1');
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_SINIESTRO_CON_DERRAME,
        expect.objectContaining({ distributorId: 'd1' }),
      );
    });

    it('si ya estaba en true, repetirlo no vuelve a avisar', async () => {
      repo.findOne.mockResolvedValue(guardado({ hazmatRelease: true }));
      await service.modificar('s1', { hazmatRelease: true }, 'd1');
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('un derrame ya informado no se puede retirar (400)', async () => {
      repo.findOne.mockResolvedValue(guardado({ hazmatRelease: true }));
      await expect(
        service.modificar('s1', { hazmatRelease: false }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('un siniestro cerrado no se modifica', async () => {
      repo.findOne.mockResolvedValue(
        guardado({ status: VehicleAccidentStatus.CLOSED }),
      );
      await expect(
        service.modificar('s1', { description: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('uno de otra distribuidora es 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.modificar('s1', { description: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cerrar', () => {
    const importes = {
      repairCost: 350000,
      insurerReimbursement: 250000,
      deductibleAmount: 50000,
    };

    it('asienta los importes y la fecha de cierre, sin tocar el vehículo', async () => {
      await service.cerrar('s1', importes, 'd1');
      expect(guardados[0]).toMatchObject({
        status: VehicleAccidentStatus.CLOSED,
        ...importes,
      });
      expect(guardados[0].closedAt).toBeInstanceOf(Date);
      expect(cars.cambiarEstadoDeFlota).not.toHaveBeenCalled();
    });

    it('un reintegro mayor que la reparación es 400 y no cierra', async () => {
      await expect(
        service.cerrar(
          's1',
          { ...importes, insurerReimbursement: 400000 },
          'd1',
        ),
      ).rejects.toThrow(
        'Reintegro de la aseguradora: el reintegro del seguro no puede superar el costo de la reparación',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('no cierra con menos que un pago de la empresa o un reintegro ya registrados (409)', async () => {
      repo.findOne.mockResolvedValue(guardado({ paymentAmount: 400000 }));
      await expect(service.cerrar('s1', importes, 'd1')).rejects.toThrow(
        'Costo de la reparación: ya se registró un pago de la empresa por más que el costo de la reparación y la franquicia',
      );
      repo.findOne.mockResolvedValue(guardado({ reimbursementAmount: 260000 }));
      await expect(service.cerrar('s1', importes, 'd1')).rejects.toThrow(
        'Reintegro de la aseguradora: ya se registró un reintegro del seguro por más que ese importe',
      );
    });

    it('cerrado dos veces es 409 «El siniestro ya está cerrado»', async () => {
      repo.findOne.mockResolvedValue(
        guardado({ status: VehicleAccidentStatus.CLOSED }),
      );
      await expect(service.cerrar('s1', importes, 'd1')).rejects.toThrow(
        'El siniestro ya está cerrado',
      );
    });
  });
});
