import { TireEventType } from '../entities/tire-event.entity';
import { TireStatus } from '../entities/tire.entity';
import { TrafficFineStatus } from '../entities/traffic-fine.entity';
import { VehicleAccidentStatus } from '../entities/vehicle-accident.entity';
import {
  movimientoValidoParaElEstado,
  multaAbierta,
  transicionDeSiniestroValida,
} from './estados';

describe('multaAbierta', () => {
  it.each([
    [TrafficFineStatus.PENDING, true],
    [TrafficFineStatus.APPEALED, true],
    [TrafficFineStatus.PAID, false],
    [TrafficFineStatus.VOIDED, false],
  ])('%s -> %s', (estado, esperado) => {
    expect(multaAbierta(estado)).toBe(esperado);
  });
});

describe('transicionDeSiniestroValida (denunciado, en revisión, en reparación)', () => {
  const { REPORTED, UNDER_REVIEW, REPAIRING, CLOSED } = VehicleAccidentStatus;

  it('avanza al estado siguiente', () => {
    expect(transicionDeSiniestroValida(REPORTED, UNDER_REVIEW)).toBe(true);
    expect(transicionDeSiniestroValida(UNDER_REVIEW, REPAIRING)).toBe(true);
  });

  it('no saltea ni retrocede', () => {
    expect(transicionDeSiniestroValida(REPORTED, REPAIRING)).toBe(false);
    expect(transicionDeSiniestroValida(REPAIRING, UNDER_REVIEW)).toBe(false);
  });

  it('no cierra por acá y un cerrado no se mueve', () => {
    expect(transicionDeSiniestroValida(REPAIRING, CLOSED)).toBe(false);
    expect(transicionDeSiniestroValida(CLOSED, CLOSED)).toBe(false);
    expect(transicionDeSiniestroValida(CLOSED, REPORTED)).toBe(false);
  });

  it('quedarse en el mismo estado abierto es válido', () => {
    expect(transicionDeSiniestroValida(UNDER_REVIEW, UNDER_REVIEW)).toBe(true);
  });
});

describe('movimientoValidoParaElEstado', () => {
  const { MOUNT, UNMOUNT, ROTATE, RETREAD, RETIRE } = TireEventType;
  const { IN_STOCK, MOUNTED, RETIRED } = TireStatus;

  it.each([
    [MOUNT, IN_STOCK, true],
    [MOUNT, MOUNTED, false],
    [MOUNT, RETIRED, false],
    [UNMOUNT, MOUNTED, true],
    [UNMOUNT, IN_STOCK, false],
    [ROTATE, MOUNTED, true],
    [ROTATE, IN_STOCK, false],
    [RETREAD, IN_STOCK, true],
    [RETREAD, MOUNTED, false],
    [RETIRE, IN_STOCK, true],
    [RETIRE, MOUNTED, true],
    [RETIRE, RETIRED, false],
  ])('%s con el neumático %s -> %s', (tipo, estado, esperado) => {
    expect(movimientoValidoParaElEstado(tipo, estado)).toBe(esperado);
  });
});
