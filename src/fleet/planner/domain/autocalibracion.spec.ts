import {
  calcularCorreccion,
  desvioDelPronostico,
  MedicionDelPronostico,
} from './autocalibracion';

const PARAMS = { cierres: 5, topeDias: 14 };

describe('calcularCorreccion', () => {
  it('con menos de tres cierres no corrige', () => {
    expect(calcularCorreccion([], PARAMS)).toBeNull();
    expect(calcularCorreccion([5, 7], PARAMS)).toBeNull();
  });

  it('con tres cierres promedia y redondea al día', () => {
    expect(calcularCorreccion([4, 5, 5], PARAMS)).toEqual({
      correctionDays: 5,
      averageDeviationDays: 4.67,
      samples: 3,
      capped: false,
      source: 'vehicle_task_type',
    });
  });

  it('un vehículo que siempre se adelanta corrige hacia atrás', () => {
    expect(calcularCorreccion([-3, -5, -4], PARAMS)?.correctionDays).toBe(-4);
  });

  it('sólo promedia los últimos N cierres (el más reciente primero)', () => {
    const r = calcularCorreccion([2, 2, 2, 40, 40, 40], {
      ...PARAMS,
      cierres: 3,
    });
    expect(r).toMatchObject({ correctionDays: 2, samples: 3 });
  });

  it('el tope acota la corrección en los dos sentidos y marca que se aplicó', () => {
    expect(calcularCorreccion([30, 40, 35], PARAMS)).toMatchObject({
      correctionDays: 14,
      averageDeviationDays: 35,
      capped: true,
    });
    expect(calcularCorreccion([-30, -40, -35], PARAMS)).toMatchObject({
      correctionDays: -14,
      capped: true,
    });
  });

  it('con el tope en 0 la autocalibración está apagada', () => {
    expect(
      calcularCorreccion([5, 5, 5], { cierres: 5, topeDias: 0 }),
    ).toBeNull();
  });

  it('un desvío medio que redondea a 0 no es "topado"', () => {
    expect(calcularCorreccion([0, 0, 1], PARAMS)).toMatchObject({
      correctionDays: 0,
      capped: false,
    });
  });
});

const DIA_MS = 86_400_000;
const T0 = new Date('2026-06-01T15:00:00Z');
const enDias = (base: Date, n: number) => new Date(base.getTime() + n * DIA_MS);

describe('desvioDelPronostico', () => {
  const base: MedicionDelPronostico = {
    primeraFecha: enDias(T0, 50),
    pronosticadaEn: T0,
    odometroAlPronosticar: 10_000,
    dueKm: 15_000,
    dueAt: null,
    cerradaEn: enDias(T0, 45),
    odometroAlCerrar: 14_500,
  };

  it('con el ritmo estimado exacto no hay desvío aunque el taller se haga antes del vencimiento', () => {
    expect(desvioDelPronostico(base)).toBe(0);
  });

  it('un vehículo que anda más de lo estimado llega antes: desvío negativo', () => {
    // 120 km/día reales contra 100 estimados, taller a los 45 días.
    expect(
      desvioDelPronostico({ ...base, odometroAlCerrar: 10_000 + 120 * 45 }),
    ).toBe(-8);
  });

  it('un vehículo que anda menos llega después: desvío positivo', () => {
    expect(
      desvioDelPronostico({ ...base, odometroAlCerrar: 10_000 + 80 * 45 }),
    ).toBe(13);
  });

  it('si mandó la fecha fija no se mide', () => {
    expect(desvioDelPronostico({ ...base, dueAt: enDias(T0, 30) })).toBeNull();
    // Una fecha fija posterior a la de kilometraje no manda: se mide.
    expect(desvioDelPronostico({ ...base, dueAt: enDias(T0, 90) })).toBe(0);
  });

  it('no se mide con menos de una semana, sin avance del odómetro o con el pronóstico ya vencido', () => {
    expect(
      desvioDelPronostico({ ...base, cerradaEn: enDias(T0, 3) }),
    ).toBeNull();
    expect(
      desvioDelPronostico({ ...base, odometroAlCerrar: 10_000 }),
    ).toBeNull();
    expect(
      desvioDelPronostico({ ...base, odometroAlPronosticar: 15_000 }),
    ).toBeNull();
  });
});

describe('autocalibración: simulación de ciclos con ventanas sesgadas', () => {
  /**
   * Cada ciclo: el planificador pronostica con `ritmoEstimado`, corrige con lo
   * aprendido, el taller se hace `sesgo` días ANTES de la fecha corregida y el
   * desvío se mide al cierre con el odómetro real.
   */
  const simular = (ritmoReal: number, ritmoEstimado: number, ciclos = 12) => {
    const intervalo = 5000;
    const desvios: number[] = [];
    const correcciones: number[] = [];
    let t0 = T0;
    let o0 = 10_000;
    let correccion = 0;
    for (let i = 0; i < ciclos; i++) {
      const crudos = Math.ceil(intervalo / ritmoEstimado);
      const taller = Math.max(8, crudos + correccion - 5); // ventana sesgada: 5 días antes
      const t1 = enDias(t0, taller);
      const o1 = o0 + Math.round(ritmoReal * taller);
      const desvio = desvioDelPronostico({
        primeraFecha: enDias(t0, crudos),
        pronosticadaEn: t0,
        odometroAlPronosticar: o0,
        dueKm: o0 + intervalo,
        dueAt: null,
        cerradaEn: t1,
        odometroAlCerrar: o1,
      });
      expect(desvio).not.toBeNull();
      desvios.unshift(desvio as number);
      correccion =
        calcularCorreccion(desvios, { cierres: 5, topeDias: 14 })
          ?.correctionDays ?? 0;
      correcciones.push(correccion);
      t0 = t1;
      o0 = o1;
    }
    return correcciones;
  };

  it('con el km/día exacto y ventanas sesgadas la corrección queda en 0: no se autorrefuerza', () => {
    expect(simular(100, 100).every((c) => c === 0)).toBe(true);
  });

  it('con un uso real 20 % mayor converge al desvío esperado, estable y sin pasar el tope', () => {
    const correcciones = simular(120, 100);
    // Esperado: 5000/120 = 41,67 → 42 días reales contra 50 pronosticados.
    const medidas = correcciones.slice(2);
    expect(medidas.every((c) => c === -8)).toBe(true);
    expect(correcciones.every((c) => Math.abs(c) <= 14)).toBe(true);
  });
});
