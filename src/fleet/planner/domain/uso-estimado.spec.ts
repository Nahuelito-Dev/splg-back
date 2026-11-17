import {
  estimarKmPorDia,
  factorDeEstacionalidad,
  mesDentroDe,
  MuestraDeUso,
  promedioDeFlota,
} from './uso-estimado';
import { sumarDias } from '../../../common/utils/dias-argentina';

const HOY = '2026-10-30';
const PARAMS = { decay: 0.7, minSampleDays: 30, staleDays: 14 };

/** Un registro por día durante `dias` días hacia atrás desde HOY, todos con los mismos km. */
const todosLosDias = (dias: number, km: number): MuestraDeUso[] =>
  Array.from({ length: dias }, (_, i) => ({ day: sumarDias(HOY, -i), km }));

describe('estimarKmPorDia', () => {
  it('uso alto: 80 km por día con registro dan 80 km/día', () => {
    const r = estimarKmPorDia(todosLosDias(56, 80), HOY, PARAMS);
    expect(r?.kmPorDia).toBeCloseTo(80, 5);
    expect(r?.diasConDato).toBe(56);
    expect(r?.desactualizado).toBe(false);
  });

  it('uso bajo: 5 km por día dan 5 km/día', () => {
    expect(
      estimarKmPorDia(todosLosDias(56, 5), HOY, PARAMS)?.kmPorDia,
    ).toBeCloseTo(5, 5);
  });

  it('un día sin registro cuenta como 0 km: un registro cada 3 días de 45 km dan ~15 km/día de calendario', () => {
    const muestras = todosLosDias(60, 45).filter((_, i) => i % 3 === 0);
    const r = estimarKmPorDia(muestras, HOY, {
      ...PARAMS,
      decay: 1,
      minSampleDays: 15,
    });
    expect(r?.kmPorDia).toBeCloseTo(15.5, 0);
    expect(r?.diasConDato).toBe(20);
  });

  it('usa 3 de cada 7 días con 100 km: ~43 km/día de calendario, no 100', () => {
    const muestras = todosLosDias(91, 100).filter((_, i) => i % 7 < 3);
    const r = estimarKmPorDia(muestras, HOY, { ...PARAMS, decay: 1 });
    expect(r?.kmPorDia).toBeGreaterThan(40);
    expect(r?.kmPorDia).toBeLessThan(46);
  });

  it('con ese ritmo el umbral se alcanza más tarde que con 100 km/día', () => {
    const muestras = todosLosDias(91, 100).filter((_, i) => i % 7 < 3);
    const kmDia = estimarKmPorDia(muestras, HOY, {
      ...PARAMS,
      decay: 1,
    })!.kmPorDia;
    const diasAlUmbral = 4300 / kmDia;
    expect(diasAlUmbral).toBeGreaterThan(90);
    expect(4300 / 100).toBeLessThan(45);
  });

  it('vehículo nuevo: cuenta desde su primer registro, no desde el inicio de la ventana', () => {
    const r = estimarKmPorDia(todosLosDias(10, 60), HOY, {
      ...PARAMS,
      minSampleDays: 5,
    });
    expect(r?.kmPorDia).toBeCloseTo(60, 5);
  });

  it('uso diario: coincide con el promedio por día con uso', () => {
    expect(
      estimarKmPorDia(todosLosDias(91, 70), HOY, PARAMS)?.kmPorDia,
    ).toBeCloseTo(70, 5);
  });

  it('las semanas recientes pesan más que las viejas', () => {
    const reciente = todosLosDias(7, 100);
    const viejas = todosLosDias(42, 10).filter(
      (m) => m.day < sumarDias(HOY, -6),
    );
    const conPeso = estimarKmPorDia([...reciente, ...viejas], HOY, {
      ...PARAMS,
      decay: 0.5,
    });
    const sinPeso = estimarKmPorDia([...reciente, ...viejas], HOY, {
      ...PARAMS,
      decay: 1,
    });
    expect(conPeso?.kmPorDia).toBeGreaterThan(sinPeso?.kmPorDia ?? Infinity);
  });

  it('sin registros no estima', () => {
    expect(estimarKmPorDia([], HOY, PARAMS)).toBeNull();
  });

  it('minSampleDays cuenta días CON registro: 20 días de historial pero 10 con dato no alcanzan', () => {
    const diez = todosLosDias(20, 40).filter((_, i) => i % 2 === 0);
    expect(
      estimarKmPorDia(diez, HOY, { ...PARAMS, minSampleDays: 11 }),
    ).toBeNull();
    expect(
      estimarKmPorDia(diez, HOY, { ...PARAMS, minSampleDays: 10 }),
    ).not.toBeNull();
  });

  it('datos viejos: si el último registro pasó los días de tolerancia, queda desactualizado', () => {
    const viejos = todosLosDias(40, 30).map((m) => ({
      ...m,
      day: sumarDias(m.day, -20),
    }));
    const r = estimarKmPorDia(viejos, HOY, PARAMS);
    expect(r?.desactualizado).toBe(true);
    expect(r?.ultimoDia).toBe(sumarDias(HOY, -20));
  });

  it('en el límite de la tolerancia todavía no está desactualizado', () => {
    const justo = todosLosDias(40, 30).map((m) => ({
      ...m,
      day: sumarDias(m.day, -14),
    }));
    expect(estimarKmPorDia(justo, HOY, PARAMS)?.desactualizado).toBe(false);
  });

  it('ignora registros futuros, de más de 13 semanas y valores inválidos', () => {
    const muestras: MuestraDeUso[] = [
      ...todosLosDias(40, 30),
      { day: '2026-12-01', km: 9999 },
      { day: sumarDias(HOY, -200), km: 9999 },
      { day: sumarDias(HOY, -1), km: Number.NaN },
      { day: sumarDias(HOY, -2), km: -5 },
    ];
    const r = estimarKmPorDia(muestras, HOY, PARAMS);
    expect(r?.kmPorDia).toBeCloseTo(30, 5);
  });

  it('un registro en 0 km es un día sin dato: no baja el promedio ni cuenta para la muestra', () => {
    const conCeros = [
      ...todosLosDias(20, 30),
      ...todosLosDias(20, 0).map((m) => ({ ...m, day: sumarDias(m.day, -20) })),
    ];
    const r = estimarKmPorDia(conCeros, HOY, { ...PARAMS, minSampleDays: 10 });
    expect(r?.kmPorDia).toBeCloseTo(30, 5);
    expect(r?.diasConDato).toBe(20);
  });

  it('el caso de la demo: recorridos de 12 a 17 km un día por medio dan ~7 km/día de calendario', () => {
    const km = [12, 17, 14, 15, 13, 16, 14, 15];
    const muestras = Array.from({ length: 40 }, (_, i) => ({
      day: sumarDias(HOY, -(i * 2)),
      km: km[i % km.length],
    }));
    const r = estimarKmPorDia(muestras, HOY, PARAMS);
    expect(r?.kmPorDia).toBeGreaterThan(6.5);
    expect(r?.kmPorDia).toBeLessThan(8);
  });
});

describe('factorDeEstacionalidad', () => {
  const dias = (mes: string, n: number, km: number): MuestraDeUso[] =>
    Array.from({ length: n }, (_, i) => ({
      day: `${mes}-${String(i + 1).padStart(2, '0')}`,
      km,
    }));

  it('es 1 con un solo mes de historial', () => {
    expect(factorDeEstacionalidad(dias('2026-10', 20, 50), 10)).toBe(1);
  });

  it('es 1 si el mes pedido casi no tiene registros', () => {
    const muestras = [...dias('2026-09', 20, 50), ...dias('2026-10', 3, 90)];
    expect(factorDeEstacionalidad(muestras, 10)).toBe(1);
  });

  it('sube el consumo de un mes más cargado que el resto', () => {
    const muestras = [...dias('2026-01', 20, 40), ...dias('2026-07', 20, 60)];
    expect(factorDeEstacionalidad(muestras, 7)).toBeCloseTo(1.2, 5);
    expect(factorDeEstacionalidad(muestras, 1)).toBeCloseTo(0.8, 5);
  });

  it('acota el factor a 0,7–1,3', () => {
    const muestras = [...dias('2026-01', 20, 10), ...dias('2026-07', 20, 100)];
    expect(factorDeEstacionalidad(muestras, 7)).toBe(1.3);
    expect(factorDeEstacionalidad(muestras, 1)).toBe(0.7);
  });

  it('es 1 si no hubo uso en todo el historial', () => {
    const muestras = [...dias('2026-01', 20, 0), ...dias('2026-07', 20, 0)];
    expect(factorDeEstacionalidad(muestras, 7)).toBe(1);
  });
});

describe('mesDentroDe y promedioDeFlota', () => {
  it('mesDentroDe cruza el cambio de mes y de año', () => {
    expect(mesDentroDe('2026-12-20', 15)).toBe(1);
    expect(mesDentroDe('2026-10-30', 0)).toBe(10);
  });

  it('promedioDeFlota promedia y devuelve null sin valores', () => {
    expect(promedioDeFlota([10, 20, 30])).toBe(20);
    expect(promedioDeFlota([])).toBeNull();
  });
});
