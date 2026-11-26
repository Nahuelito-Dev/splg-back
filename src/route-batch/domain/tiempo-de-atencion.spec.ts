import {
  DURACION_MAXIMA_VALIDA_MIN,
  MUESTRAS_MINIMAS,
  calcularTiempoDeAtencion,
  minutosDeServicio,
  percentil,
} from './tiempo-de-atencion';

/** `n` duraciones iguales. */
const iguales = (n: number, minutos: number): number[] =>
  Array.from({ length: n }, () => minutos);

describe('calcularTiempoDeAtencion', () => {
  it(`con menos de ${MUESTRAS_MINIMAS} entregas válidas no aprende`, () => {
    const r = calcularTiempoDeAtencion(iguales(MUESTRAS_MINIMAS - 1, 8));
    expect(r).toEqual({
      samples: MUESTRAS_MINIMAS - 1,
      medianMin: null,
      p90Min: null,
    });
  });

  it(`con exactamente ${MUESTRAS_MINIMAS} entregas válidas ya aprende`, () => {
    const r = calcularTiempoDeAtencion(iguales(MUESTRAS_MINIMAS, 8));
    expect(r).toEqual({ samples: MUESTRAS_MINIMAS, medianMin: 8, p90Min: 8 });
  });

  it('el mínimo son 20 entregas: con 19 no aprende y con 20 sí', () => {
    expect(calcularTiempoDeAtencion(iguales(19, 8)).medianMin).toBeNull();
    expect(calcularTiempoDeAtencion(iguales(20, 8)).medianMin).toBe(8);
  });

  it('la mediana y el p90 de una serie 0,5..50 (con el 5 % de cada punta recortado)', () => {
    const serie = Array.from({ length: 100 }, (_, i) => (i + 1) * 0.5); // 0,5 a 50
    const r = calcularTiempoDeAtencion(serie);
    // Recortadas 5 por punta quedan 90 valores, de 3 a 47,5.
    expect(r.samples).toBe(100);
    expect(r.medianMin).toBe(25.25);
    expect(r.p90Min).toBe(43.05);
  });

  it('descarta las duraciones no positivas y las de más de tres horas, y no cuentan como muestra', () => {
    const r = calcularTiempoDeAtencion([
      ...iguales(MUESTRAS_MINIMAS - 1, 8),
      0,
      -3,
      DURACION_MAXIMA_VALIDA_MIN + 1,
      Number.NaN,
    ]);
    expect(r.samples).toBe(MUESTRAS_MINIMAS - 1);
    expect(r.medianMin).toBeNull();
  });

  it('una duración justo en el máximo válido sí cuenta', () => {
    const r = calcularTiempoDeAtencion([
      ...iguales(MUESTRAS_MINIMAS - 1, 8),
      DURACION_MAXIMA_VALIDA_MIN,
    ]);
    expect(r.samples).toBe(MUESTRAS_MINIMAS);
  });

  it('los extremos recortados no mueven la mediana', () => {
    const r = calcularTiempoDeAtencion([
      ...iguales(18, 10),
      0.1,
      170, // 20 muestras: se recorta 1 por punta
    ]);
    expect(r.medianMin).toBe(10);
  });

  it('lleva el resultado al rango 1 a 60', () => {
    expect(calcularTiempoDeAtencion(iguales(30, 0.4)).medianMin).toBe(1);
    expect(calcularTiempoDeAtencion(iguales(30, 120)).medianMin).toBe(60);
    expect(calcularTiempoDeAtencion(iguales(30, 120)).p90Min).toBe(60);
  });

  it('el p90 nunca queda por debajo de la mediana', () => {
    const r = calcularTiempoDeAtencion(iguales(25, 0.4));
    expect(r.p90Min).toBeGreaterThanOrEqual(r.medianMin as number);
  });
});

describe('percentil', () => {
  it('interpola entre vecinos', () => {
    expect(percentil([10, 20], 0.5)).toBe(15);
    expect(percentil([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 5);
  });
  it('lista vacía: 0', () => {
    expect(percentil([], 0.5)).toBe(0);
  });
});

describe('minutosDeServicio', () => {
  it('fixed: el fijo aunque haya aprendido', () => {
    expect(minutosDeServicio(10, 'fixed', 7)).toBe(10);
  });
  it('learned con muestra: la mediana redondeada', () => {
    expect(minutosDeServicio(10, 'learned', 7.4)).toBe(7);
    expect(minutosDeServicio(10, 'learned', 7.5)).toBe(8);
  });
  it('learned sin muestra: el fijo', () => {
    expect(minutosDeServicio(10, 'learned', null)).toBe(10);
  });
  it('learned: queda en el rango 1 a 60', () => {
    expect(minutosDeServicio(10, 'learned', 0.2)).toBe(1);
    expect(minutosDeServicio(10, 'learned', 99)).toBe(60);
  });
});
