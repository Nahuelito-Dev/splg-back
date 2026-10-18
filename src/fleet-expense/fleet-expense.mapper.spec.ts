import { FuelType } from '../car/entities/car.entity';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { FuelLoad, FuelPaymentMethod } from './entities/fuel-load.entity';
import { TireEvent, TireEventType } from './entities/tire-event.entity';
import { Tire, TireStatus } from './entities/tire.entity';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';
import {
  VehicleAccident,
  VehicleAccidentStatus,
} from './entities/vehicle-accident.entity';

describe('FleetExpenseMapper', () => {
  it('la carga trae la patente, el nombre de quien cargó y la anulación', () => {
    const dto = FleetExpenseMapper.fuelLoad({
      fuelLoadId: 'f1',
      distributorId: 'd1',
      carId: 'c1',
      car: { carPatent: 'AB123CD' },
      employeeId: 'e1',
      employee: { firstName: 'Ana', lastName: 'Pérez' },
      loadedAt: new Date(),
      fuelType: FuelType.DIESEL,
      liters: 40,
      unitPrice: 1000,
      totalAmount: 40000,
      odometerKm: 1000,
      isFullTank: true,
      station: null,
      paymentMethod: FuelPaymentMethod.CARD,
      receiptNumber: null,
      anomaly: false,
      notes: null,
      odometerCorrectionNote: null,
      deletedAt: new Date('2026-10-01'),
      createdAt: new Date(),
    } as unknown as FuelLoad);
    expect(dto).toMatchObject({
      carPatent: 'AB123CD',
      employeeName: 'Ana Pérez',
      voidedAt: new Date('2026-10-01'),
    });
  });

  it('sin relaciones cargadas, patente y nombre son null', () => {
    const dto = FleetExpenseMapper.trafficFine({
      fineId: 'm1',
      status: TrafficFineStatus.PENDING,
    } as TrafficFine);
    expect(dto).toMatchObject({ carPatent: null, employeeName: null });
  });

  it('el siniestro expone el punto como "lat,lng" y el costo neto sólo si se cerró', () => {
    const abierto = FleetExpenseMapper.vehicleAccident({
      accidentId: 's1',
      status: VehicleAccidentStatus.REPORTED,
      location: { type: 'Point', coordinates: [-55.8961, -27.3671] },
      repairCost: null,
      insurerReimbursement: null,
    } as VehicleAccident);
    expect(abierto).toMatchObject({
      location: '-27.3671,-55.8961',
      netCost: null,
    });

    const cerrado = FleetExpenseMapper.vehicleAccident({
      accidentId: 's1',
      status: VehicleAccidentStatus.CLOSED,
      location: null,
      repairCost: 350000,
      insurerReimbursement: 250000,
    } as VehicleAccident);
    expect(cerrado).toMatchObject({ location: null, netCost: 100000 });
  });

  it('el neumático incluye su historial sólo si se lo pasan', () => {
    const tire = {
      tireId: 't1',
      status: TireStatus.IN_STOCK,
      kmTraveled: 0,
    } as Tire;
    expect(FleetExpenseMapper.tire(tire).events).toBeUndefined();
    const evento = {
      eventId: 'x1',
      tireId: 't1',
      type: TireEventType.MOUNT,
      odometerKm: 10,
    } as TireEvent;
    expect(FleetExpenseMapper.tire(tire, [evento]).events).toEqual([
      expect.objectContaining({ eventId: 'x1', type: TireEventType.MOUNT }),
    ]);
  });
});
