import { MissingStopLoadError } from './errors/route-sheet.errors';
import {
  buildLoadProfile,
  checkCapacity,
  fitsCapacity,
  loadPeaks,
  SIN_CARGA,
  StopLoad,
} from './load-profile';

const carga = (extra: Partial<StopLoad>): StopLoad => ({
  ...SIN_CARGA,
  ...extra,
});

/** Canje 1 a 1 de garrafas de 10 kg de gas: sale la llena (22 kg), vuelve la vacía (12 kg). */
const canje = (n: number): StopLoad =>
  carga({
    deliverUnits: n,
    deliverKg: 22 * n,
    collectUnits: n,
    collectKg: 12 * n,
  });

describe('buildLoadProfile', () => {
  it('sale con todas las llenas y descarga a medida que entrega', () => {
    const p = buildLoadProfile(
      ['a', 'b'],
      new Map([
        ['a', carga({ deliverUnits: 2, deliverKg: 44 })],
        ['b', carga({ deliverUnits: 1, deliverKg: 22 })],
      ]),
    );
    expect(p.departure).toEqual({ units: 3, kg: 66 });
    expect(p.afterStop).toEqual([
      { id: 'a', units: 1, kg: 22 },
      { id: 'b', units: 0, kg: 0 },
    ]);
    expect(p.totalUnits).toBe(3);
    expect(p.totalKg).toBe(66);
    expect(p.peakUnits).toBe(3);
    expect(p.peakKg).toBe(66);
  });

  it('con canje 1 a 1 las unidades se mantienen y los kilos bajan 10 por garrafa', () => {
    const p = buildLoadProfile(
      ['a', 'b'],
      new Map([
        ['a', canje(2)],
        ['b', canje(1)],
      ]),
    );
    expect(p.departure).toEqual({ units: 3, kg: 66 });
    expect(p.afterStop.map((x) => x.units)).toEqual([3, 3]);
    expect(p.afterStop.map((x) => x.kg)).toEqual([46, 36]);
    expect(p.peakUnits).toBe(3);
    expect(p.peakKg).toBe(66);
  });

  it('los retiros de envases (M5) suben las unidades: el pico de unidades es al final', () => {
    const p = buildLoadProfile(
      ['a', 'b'],
      new Map([
        [
          'a',
          carga({
            deliverUnits: 1,
            deliverKg: 22,
            pickupUnits: 2,
            pickupKg: 24,
          }),
        ],
        [
          'b',
          carga({
            deliverUnits: 1,
            deliverKg: 22,
            pickupUnits: 1,
            pickupKg: 12,
          }),
        ],
      ]),
    );
    expect(p.departure.units).toBe(2);
    expect(p.afterStop.map((x) => x.units)).toEqual([3, 3]);
    expect(p.peakUnits).toBe(3);
    // 44 kg a la salida; después de la primera parada: 44 - 22 + 24 = 46.
    expect(p.afterStop.map((x) => x.kg)).toEqual([46, 36]);
    expect(p.peakKg).toBe(46);
  });

  it('el pico de unidades depende del orden: retirar primero lo sube antes', () => {
    const cargas = new Map([
      ['retira', carga({ pickupUnits: 4, pickupKg: 48 })],
      ['entrega', carga({ deliverUnits: 4, deliverKg: 88 })],
    ]);
    expect(buildLoadProfile(['retira', 'entrega'], cargas).peakUnits).toBe(8);
    expect(buildLoadProfile(['entrega', 'retira'], cargas).peakUnits).toBe(4);
  });

  it('suma las vacías con las que sale el vehículo', () => {
    const p = buildLoadProfile(['a'], new Map([['a', canje(1)]]), {
      units: 5,
      kg: 60,
    });
    expect(p.departure).toEqual({ units: 6, kg: 82 });
    expect(p.peakUnits).toBe(6);
  });

  it('un pedido sin carga en el mapa es un error, no un cero', () => {
    expect(() => buildLoadProfile(['x'], new Map())).toThrow(
      MissingStopLoadError,
    );
    expect(() => loadPeaks(['x'], new Map())).toThrow(MissingStopLoadError);
    expect(() =>
      fitsCapacity(['x'], new Map(), { capacityKg: 1, capacityUnits: 1 }),
    ).toThrow(MissingStopLoadError);
  });

  it('un pedido que no mueve nada se declara con SIN_CARGA y una hoja vacía queda en cero', () => {
    expect(buildLoadProfile(['x'], new Map([['x', SIN_CARGA]])).peakUnits).toBe(
      0,
    );
    const vacia = buildLoadProfile([], new Map());
    expect(vacia.departure).toEqual({ units: 0, kg: 0 });
    expect(vacia.afterStop).toEqual([]);
  });

  it('redondea los kilos a dos decimales', () => {
    const p = buildLoadProfile(
      ['a', 'b', 'c'],
      new Map([
        ['a', carga({ deliverKg: 0.1 })],
        ['b', carga({ deliverKg: 0.2 })],
        ['c', carga({ deliverKg: 0.3 })],
      ]),
    );
    expect(p.departure.kg).toBe(0.6);
    expect(p.afterStop[2].kg).toBe(0);
  });
});

describe('checkCapacity', () => {
  const perfil = buildLoadProfile(
    ['a', 'b'],
    new Map([
      [
        'a',
        carga({ deliverUnits: 3, deliverKg: 66, pickupUnits: 4, pickupKg: 48 }),
      ],
      ['b', carga({ deliverUnits: 1, deliverKg: 22 })],
    ]),
  );
  // Sale con 4 unidades / 88 kg; después de a: 5 u / 70 kg; después de b: 4 u / 48 kg.

  it('entra si el pico de kilos y de unidades están dentro', () => {
    expect(
      checkCapacity(perfil, { capacityKg: 100, capacityUnits: 5 }),
    ).toEqual({
      fits: true,
      kgExceeded: false,
      unitsExceeded: false,
      firstExceededAfter: null,
    });
  });

  it('no entra por kilos aunque las unidades sobren', () => {
    const c = checkCapacity(perfil, { capacityKg: 80, capacityUnits: 50 });
    expect(c.fits).toBe(false);
    expect(c.kgExceeded).toBe(true);
    expect(c.unitsExceeded).toBe(false);
  });

  it('no entra por unidades aunque los kilos sobren, y dice después de qué parada se pasa', () => {
    const c = checkCapacity(perfil, { capacityKg: 1000, capacityUnits: 4 });
    expect(c.fits).toBe(false);
    expect(c.unitsExceeded).toBe(true);
    expect(c.kgExceeded).toBe(false);
    expect(c.firstExceededAfter).toBe('a');
  });

  it('si ya se pasa a la salida no hay «parada» a la que culpar', () => {
    const c = checkCapacity(perfil, { capacityKg: 50, capacityUnits: null });
    expect(c.kgExceeded).toBe(true);
    expect(c.firstExceededAfter).toBeNull();
  });

  it('una capacidad justa entra', () => {
    expect(
      checkCapacity(perfil, { capacityKg: 88, capacityUnits: 5 }).fits,
    ).toBe(true);
  });

  it('sin capacidad cargada no hay tope', () => {
    expect(
      checkCapacity(perfil, { capacityKg: null, capacityUnits: null }).fits,
    ).toBe(true);
  });
});

describe('loadPeaks y fitsCapacity (camino caliente)', () => {
  // Sale con 4 unidades / 88 kg; después de a: 5 u / 70 kg; después de b: 4 u / 48 kg.
  const cargas = new Map([
    [
      'a',
      carga({ deliverUnits: 3, deliverKg: 66, pickupUnits: 4, pickupKg: 48 }),
    ],
    ['b', carga({ deliverUnits: 1, deliverKg: 22 })],
  ]);
  const orden = ['a', 'b'];

  it('dan los mismos picos que el perfil completo', () => {
    const perfil = buildLoadProfile(orden, cargas);
    expect(loadPeaks(orden, cargas)).toEqual({
      peakUnits: perfil.peakUnits,
      peakKg: perfil.peakKg,
    });
    expect(loadPeaks(orden, cargas)).toEqual({ peakUnits: 5, peakKg: 88 });
  });

  it('el pico de unidades puede estar después de una parada, no sólo a la salida', () => {
    expect(loadPeaks(orden, cargas).peakUnits).toBe(5);
  });

  it('coincide con checkCapacity en kilos, en unidades y en el borde', () => {
    const perfil = buildLoadProfile(orden, cargas);
    const casos = [
      { capacityKg: 88, capacityUnits: 5 },
      { capacityKg: 87.9, capacityUnits: 5 },
      { capacityKg: 88, capacityUnits: 4 },
      { capacityKg: null, capacityUnits: 4 },
      { capacityKg: 50, capacityUnits: null },
      { capacityKg: null, capacityUnits: null },
    ];
    for (const c of casos) {
      expect(fitsCapacity(orden, cargas, c)).toBe(
        checkCapacity(perfil, c).fits,
      );
    }
    expect(fitsCapacity(orden, cargas, casos[1])).toBe(false);
    expect(fitsCapacity(orden, cargas, casos[2])).toBe(false);
  });

  it('los envases que ya van a bordo se suman a la salida', () => {
    expect(loadPeaks(orden, cargas, { units: 2, kg: 24 })).toEqual({
      peakUnits: 7,
      peakKg: 112,
    });
  });
});
