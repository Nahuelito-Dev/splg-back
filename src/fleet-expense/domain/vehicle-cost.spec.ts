import {
  calcularCostoDeVehiculo,
  EntradasDeCosto,
  mesesDelRango,
  numeroDeDia,
  resumirTablero,
} from './vehicle-cost';

const vacio: EntradasDeCosto = {
  maintenance: [],
  insurance: [],
  fuel: [],
  fines: [],
  accidents: [],
  usageKm: 0,
};

/** Mediodía argentino de un día: 15:00 UTC. */
const dia = (iso: string) => new Date(`${iso}T15:00:00.000Z`);
/** Fecha de calendario como la guarda la flota: medianoche UTC. */
const fecha = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('calcularCostoDeVehiculo (CU-203)', () => {
  it('suma los cinco rubros del rango y deja afuera lo de otros días', () => {
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        maintenance: [
          { performedAt: dia('2026-10-10'), cost: 100000 },
          { performedAt: dia('2026-09-30'), cost: 999 },
        ],
        fuel: [
          { loadedAt: dia('2026-10-05'), totalAmount: 40000, odometerKm: 1000 },
          { loadedAt: dia('2026-11-01'), totalAmount: 888, odometerKm: 2000 },
        ],
        fines: [
          { paidAt: '2026-10-20', paidAmount: 59500 },
          { paidAt: '2026-11-02', paidAmount: 777 },
        ],
        accidents: [
          {
            closedAt: dia('2026-10-25'),
            repairCost: 350000,
            insurerReimbursement: 250000,
          },
        ],
        usageKm: 2000,
      },
      '2026-10-01',
      '2026-10-31',
    );
    expect(costo).toMatchObject({
      maintenance: 100000,
      insurance: 0,
      fuel: 40000,
      fines: 59500,
      accidents: 100000,
      total: 299500,
      km: 2000,
      kmSource: 'usage_log',
      costPerKm: 149.75,
    });
  });

  it('el día de borde pertenece al rango en hora argentina', () => {
    // 02:00 UTC del 1/11 es todavía el 31/10 a las 23:00 en Argentina.
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        fuel: [
          {
            loadedAt: new Date('2026-11-01T02:00:00.000Z'),
            totalAmount: 100,
            odometerKm: 1,
          },
        ],
      },
      '2026-10-01',
      '2026-10-31',
    );
    expect(costo.fuel).toBe(100);
  });

  it('prorratea la prima por los días de la vigencia que caen en el rango', () => {
    // Póliza del 1/1 al 31/12/2026 (365 días), prima 365000: 1000 por día.
    const poliza = {
      validFrom: fecha('2026-01-01'),
      dueAt: fecha('2026-12-31'),
      cost: 365000,
    };
    const costo = calcularCostoDeVehiculo(
      { ...vacio, insurance: [poliza] },
      '2026-10-01',
      '2026-10-31',
    );
    expect(costo.insurance).toBe(31000);
    expect(costo.insuranceEstimated).toBe(false);
  });

  it('una póliza que se solapa en parte sólo cuenta los días solapados', () => {
    // Vigencia del 15/10 al 14/10 del año siguiente; el rango toma 15 a 31/10 = 17 días.
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        insurance: [
          {
            validFrom: fecha('2026-10-15'),
            dueAt: fecha('2027-10-14'),
            cost: 365000,
          },
        ],
      },
      '2026-10-01',
      '2026-10-31',
    );
    expect(costo.insurance).toBe(17000);
  });

  it('una póliza fuera del rango no suma', () => {
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        insurance: [
          {
            validFrom: fecha('2025-01-01'),
            dueAt: fecha('2025-12-31'),
            cost: 365000,
          },
        ],
      },
      '2026-10-01',
      '2026-10-31',
    );
    expect(costo.insurance).toBe(0);
  });

  it('sin inicio de vigencia prorratea con un año hacia atrás y lo indica como estimado', () => {
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        insurance: [
          { validFrom: null, dueAt: fecha('2026-12-31'), cost: 365000 },
        ],
      },
      '2026-10-01',
      '2026-10-31',
    );
    // 2026-12-31 menos 365 días = 2025-12-31; vigencia de 366 días.
    expect(costo.insurance).toBeCloseTo((365000 * 31) / 366, 2);
    expect(costo.insuranceEstimated).toBe(true);
  });

  it('los km salen del registro de uso y, si no hay, de la diferencia de kilometraje entre cargas', () => {
    const cargas = [
      { loadedAt: dia('2026-10-02'), totalAmount: 10, odometerKm: 10000 },
      { loadedAt: dia('2026-10-20'), totalAmount: 10, odometerKm: 10800 },
    ];
    const sinRegistro = calcularCostoDeVehiculo(
      { ...vacio, fuel: cargas },
      '2026-10-01',
      '2026-10-31',
    );
    expect(sinRegistro).toMatchObject({ km: 800, kmSource: 'odometer' });

    const conRegistro = calcularCostoDeVehiculo(
      { ...vacio, fuel: cargas, usageKm: 500 },
      '2026-10-01',
      '2026-10-31',
    );
    expect(conRegistro).toMatchObject({ km: 500, kmSource: 'usage_log' });
  });

  it('sin km no hay costo por km pero el total se calcula', () => {
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        maintenance: [{ performedAt: dia('2026-10-10'), cost: 5000 }],
      },
      '2026-10-01',
      '2026-10-31',
    );
    expect(costo).toMatchObject({
      total: 5000,
      km: 0,
      kmSource: 'none',
      costPerKm: null,
    });
  });

  it('la evolución mensual cubre todos los meses del rango y suma el total', () => {
    const costo = calcularCostoDeVehiculo(
      {
        ...vacio,
        maintenance: [
          { performedAt: dia('2026-09-15'), cost: 100 },
          { performedAt: dia('2026-11-15'), cost: 300 },
        ],
        fuel: [
          { loadedAt: dia('2026-10-15'), totalAmount: 200, odometerKm: 1 },
        ],
      },
      '2026-09-01',
      '2026-11-30',
    );
    expect(costo.monthly.map((m) => [m.month, m.total])).toEqual([
      ['2026-09', 100],
      ['2026-10', 200],
      ['2026-11', 300],
    ]);
    expect(costo.monthly.reduce((s, m) => s + m.total, 0)).toBe(costo.total);
  });
});

describe('helpers de fechas', () => {
  it('mesesDelRango incluye el primero y el último y cruza el año', () => {
    expect(mesesDelRango('2026-11-20', '2027-02-03')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('numeroDeDia cuenta días enteros', () => {
    expect(numeroDeDia('2026-03-01') - numeroDeDia('2026-02-01')).toBe(28);
  });
});

describe('resumirTablero: km sin ruido de coma flotante', () => {
  it('suma los km a 2 decimales', () => {
    const fila = (km: number) => ({
      maintenance: 1,
      insurance: 0,
      fuel: 0,
      fines: 0,
      accidents: 0,
      total: 1,
      km,
    });
    expect(resumirTablero([fila(0.1), fila(0.2)]).km).toBe(0.3);
  });
});
