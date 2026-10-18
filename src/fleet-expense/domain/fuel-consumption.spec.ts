import {
  armarTramos,
  CargaParaConsumo,
  esConsumoAnomalo,
  importeCoincide,
  litrosEntranEnElTanque,
  ordenarCargas,
  totalizarTramos,
} from './fuel-consumption';

let n = 0;
function carga(
  odometerKm: number,
  liters: number,
  over: Partial<CargaParaConsumo> = {},
): CargaParaConsumo {
  n++;
  return {
    fuelLoadId: `c${String(n).padStart(3, '0')}`,
    odometerKm,
    liters,
    totalAmount: liters * 1000,
    isFullTank: true,
    loadedAt: new Date(Date.UTC(2026, 0, n)),
    ...over,
  };
}

describe('importeCoincide (tolerancia del 1 %)', () => {
  it('acepta el importe exacto y el que se aparta menos de 1 %', () => {
    expect(importeCoincide(40, 1000, 40000)).toBe(true);
    expect(importeCoincide(40, 1000, 40399)).toBe(true);
    expect(importeCoincide(40, 1000, 39601)).toBe(true);
  });

  it('rechaza el que se aparta más de 1 %', () => {
    expect(importeCoincide(40, 1000, 40401)).toBe(false);
    expect(importeCoincide(40, 1000, 39000)).toBe(false);
  });
});

describe('litrosEntranEnElTanque (capacidad + 5 %)', () => {
  it('sin capacidad cargada no se controla', () => {
    expect(litrosEntranEnElTanque(500, null)).toBe(true);
  });

  it('acepta hasta un 5 % más que la capacidad', () => {
    expect(litrosEntranEnElTanque(63, 60)).toBe(true);
    expect(litrosEntranEnElTanque(63.01, 60)).toBe(false);
  });
});

describe('armarTramos (método del tanque lleno)', () => {
  beforeEach(() => {
    n = 0;
  });

  it('el tramo es de km sobre los litros cargados DESPUÉS de la primera carga llena', () => {
    const cargas = ordenarCargas([
      carga(1000, 50), // ancla: sus litros no cuentan
      carga(1300, 20, { isFullTank: false }),
      carga(1500, 30), // cierra el tramo: 500 km / 50 L
    ]);
    const [tramo] = armarTramos(cargas);
    expect(tramo).toMatchObject({
      km: 500,
      liters: 50,
      kmPerLiter: 10,
      amount: 50000,
      costPerKm: 100,
    });
  });

  it('lo cargado antes de la primera carga llena no se puede medir', () => {
    const cargas = ordenarCargas([
      carga(900, 10, { isFullTank: false }),
      carga(1000, 40),
      carga(1400, 40),
    ]);
    const tramos = armarTramos(cargas);
    expect(tramos).toHaveLength(1);
    expect(tramos[0].liters).toBe(40);
  });

  it('con menos de dos cargas llenas no hay tramos', () => {
    expect(armarTramos([carga(1000, 40)])).toEqual([]);
    expect(
      armarTramos(
        ordenarCargas([
          carga(1000, 40),
          carga(1100, 20, { isFullTank: false }),
        ]),
      ),
    ).toEqual([]);
  });

  it('un tramo sin kilómetros se descarta', () => {
    const tramos = armarTramos(
      ordenarCargas([carga(1000, 40), carga(1000, 40)]),
    );
    expect(tramos).toEqual([]);
  });

  it('totalizarTramos suma y calcula las razones; sin tramos son nulas', () => {
    const tramos = armarTramos(
      ordenarCargas([carga(0, 40), carga(400, 40), carga(1000, 60)]),
    );
    expect(totalizarTramos(tramos)).toMatchObject({
      km: 1000,
      liters: 100,
      amount: 100000,
      kmPerLiter: 10,
      costPerKm: 100,
    });
    expect(totalizarTramos([])).toEqual({
      km: 0,
      liters: 0,
      amount: 0,
      kmPerLiter: null,
      costPerKm: null,
    });
  });
});

describe('esConsumoAnomalo (más de 25 % del promedio de las últimas cinco)', () => {
  beforeEach(() => {
    n = 0;
  });

  /** Siete cargas llenas a 10 km/L: seis tramos estables. */
  function historialEstable(): CargaParaConsumo[] {
    return Array.from({ length: 7 }, (_, i) => carga(i * 400, 40));
  }

  it('un tramo igual al habitual no es anómalo', () => {
    const cargas = [...historialEstable(), carga(7 * 400, 40)];
    const ultima = cargas[cargas.length - 1];
    expect(esConsumoAnomalo(ordenarCargas(cargas), ultima.fuelLoadId)).toBe(
      false,
    );
  });

  it('un tramo con 26 % menos rendimiento es anómalo', () => {
    // 400 km con 54 L = 7,4 km/L (26 % menos que 10)
    const cargas = [...historialEstable(), carga(7 * 400, 54)];
    const ultima = cargas[cargas.length - 1];
    expect(esConsumoAnomalo(ordenarCargas(cargas), ultima.fuelLoadId)).toBe(
      true,
    );
  });

  it('un tramo con 24 % menos rendimiento no lo es', () => {
    // 400 km con 52,6 L = 7,6 km/L (24 % menos)
    const cargas = [...historialEstable(), carga(7 * 400, 52.6)];
    const ultima = cargas[cargas.length - 1];
    expect(esConsumoAnomalo(ordenarCargas(cargas), ultima.fuelLoadId)).toBe(
      false,
    );
  });

  it('también el rendimiento muy superior al habitual es anómalo', () => {
    const cargas = [...historialEstable(), carga(7 * 400, 25)]; // 16 km/L
    const ultima = cargas[cargas.length - 1];
    expect(esConsumoAnomalo(ordenarCargas(cargas), ultima.fuelLoadId)).toBe(
      true,
    );
  });

  it('el primer tramo no tiene contra qué compararse', () => {
    const cargas = [carga(0, 40), carga(400, 80)];
    expect(esConsumoAnomalo(ordenarCargas(cargas), cargas[1].fuelLoadId)).toBe(
      false,
    );
  });

  it('una carga parcial nunca cierra un tramo', () => {
    const parcial = carga(7 * 400, 54, { isFullTank: false });
    const cargas = [...historialEstable(), parcial];
    expect(esConsumoAnomalo(ordenarCargas(cargas), parcial.fuelLoadId)).toBe(
      false,
    );
  });

  it('sólo se compara con los cinco tramos anteriores', () => {
    // Seis tramos viejos a 5 km/L y luego cinco a 10 km/L: el promedio de las
    // últimas cinco es 10, no el de las once.
    const viejos = Array.from({ length: 7 }, (_, i) => carga(i * 400, 80));
    const base = 6 * 400;
    const nuevos = Array.from({ length: 5 }, (_, i) =>
      carga(base + (i + 1) * 400, 40),
    );
    const ultima = carga(base + 6 * 400, 40);
    const cargas = ordenarCargas([...viejos, ...nuevos, ultima]);
    expect(esConsumoAnomalo(cargas, ultima.fuelLoadId)).toBe(false);
  });

  it('una carga que no está en la lista no es anómala', () => {
    expect(esConsumoAnomalo(historialEstable(), 'no-existe')).toBe(false);
  });
});
