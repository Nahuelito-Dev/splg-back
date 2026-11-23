import { proyectarVencimiento } from './proyeccion-de-vencimiento';

const HOY = new Date('2026-10-30T12:00:00Z');
const dia = (n: number) => new Date(HOY.getTime() + n * 86_400_000);

describe('proyectarVencimiento', () => {
  it('por kilometraje: los km que faltan sobre el consumo diario', () => {
    const r = proyectarVencimiento({
      dueAt: null,
      dueKm: 10_500,
      odometerKm: 10_000,
      kmPorDia: 50,
      hoy: HOY,
    });
    expect(r.kmFaltantes).toBe(500);
    expect(r.porKilometraje).toEqual(dia(10));
    expect(r.fecha).toEqual(dia(10));
    expect(r.enObservacion).toBe(false);
  });

  it('redondea los días hacia arriba', () => {
    const r = proyectarVencimiento({
      dueAt: null,
      dueKm: 10_101,
      odometerKm: 10_000,
      kmPorDia: 50,
      hoy: HOY,
    });
    expect(r.porKilometraje).toEqual(dia(3));
  });

  it('uso bajo: tarda mucho más que con uso alto', () => {
    const base = { dueAt: null, dueKm: 11_000, odometerKm: 10_000, hoy: HOY };
    const alto = proyectarVencimiento({ ...base, kmPorDia: 100 });
    const bajo = proyectarVencimiento({ ...base, kmPorDia: 5 });
    expect(alto.porKilometraje).toEqual(dia(10));
    expect(bajo.porKilometraje).toEqual(dia(200));
  });

  it('un kilometraje ya alcanzado vence hoy', () => {
    const r = proyectarVencimiento({
      dueAt: null,
      dueKm: 10_000,
      odometerKm: 10_250,
      kmPorDia: 40,
      hoy: HOY,
    });
    expect(r.kmFaltantes).toBe(-250);
    expect(r.fecha).toEqual(HOY);
  });

  it('con fecha fija y kilometraje vence lo primero que llegue', () => {
    const porFecha = proyectarVencimiento({
      dueAt: dia(5),
      dueKm: 20_000,
      odometerKm: 10_000,
      kmPorDia: 50,
      hoy: HOY,
    });
    expect(porFecha.fecha).toEqual(dia(5));
    const porKm = proyectarVencimiento({
      dueAt: dia(500),
      dueKm: 10_100,
      odometerKm: 10_000,
      kmPorDia: 50,
      hoy: HOY,
    });
    expect(porKm.fecha).toEqual(dia(2));
  });

  it('sin historial de uso queda en observación (sin fecha)', () => {
    const r = proyectarVencimiento({
      dueAt: null,
      dueKm: 10_500,
      odometerKm: 10_000,
      kmPorDia: null,
      hoy: HOY,
    });
    expect(r.fecha).toBeNull();
    expect(r.enObservacion).toBe(true);
  });

  it('sin historial pero con fecha fija usa la fecha y no queda en observación', () => {
    const r = proyectarVencimiento({
      dueAt: dia(30),
      dueKm: 10_500,
      odometerKm: 10_000,
      kmPorDia: null,
      hoy: HOY,
    });
    expect(r.fecha).toEqual(dia(30));
    expect(r.enObservacion).toBe(false);
  });

  it('un consumo cero no proyecta por kilometraje', () => {
    const r = proyectarVencimiento({
      dueAt: null,
      dueKm: 10_500,
      odometerKm: 10_000,
      kmPorDia: 0,
      hoy: HOY,
    });
    expect(r.porKilometraje).toBeNull();
  });

  it('una tarea de fecha fija se proyecta a su fecha', () => {
    const r = proyectarVencimiento({
      dueAt: dia(12),
      dueKm: null,
      odometerKm: 10_000,
      kmPorDia: 30,
      hoy: HOY,
    });
    expect(r.fecha).toEqual(dia(12));
    expect(r.kmFaltantes).toBeNull();
  });

  it('sin odómetro no hay kilómetros que faltan', () => {
    const r = proyectarVencimiento({
      dueAt: null,
      dueKm: 10_500,
      odometerKm: null,
      kmPorDia: 30,
      hoy: HOY,
    });
    expect(r.kmFaltantes).toBeNull();
    expect(r.fecha).toBeNull();
  });

  describe('con corrección por el desvío del vehículo', () => {
    const correccion = (correctionDays: number) => ({
      correctionDays,
      averageDeviationDays: correctionDays,
      samples: 4,
      capped: false,
      source: 'vehicle_task_type' as const,
    });
    const base = { dueAt: null, dueKm: 10_500, odometerKm: 10_000, hoy: HOY };

    it('corre la fecha por kilometraje y deja la original', () => {
      const r = proyectarVencimiento({
        ...base,
        kmPorDia: 50,
        correccion: correccion(5),
      });
      expect(r.porKilometrajeSinCorregir).toEqual(dia(10));
      expect(r.porKilometraje).toEqual(dia(15));
      expect(r.fecha).toEqual(dia(15));
      expect(r.correccion).toEqual(correccion(5));
    });

    it('un desvío negativo adelanta pero nunca antes de hoy', () => {
      const r = proyectarVencimiento({
        ...base,
        kmPorDia: 50,
        correccion: correccion(-30),
      });
      expect(r.porKilometraje).toEqual(HOY);
    });

    it('informa lo efectivamente aplicado cuando la fecha no puede ir antes de hoy', () => {
      const r = proyectarVencimiento({
        ...base,
        kmPorDia: 50,
        correccion: correccion(-30),
      });
      expect(r.correccion?.correctionDays).toBe(-10);
    });

    it('no informa corrección si manda la fecha fija', () => {
      const r = proyectarVencimiento({
        ...base,
        dueAt: dia(12),
        kmPorDia: 50,
        correccion: correccion(5),
      });
      expect(r.fecha).toEqual(dia(12));
      expect(r.correccion).toBeNull();
    });

    it('no toca la fecha fija: vence la primera que llegue', () => {
      const r = proyectarVencimiento({
        ...base,
        dueAt: dia(12),
        kmPorDia: 50,
        correccion: correccion(5),
      });
      expect(r.fecha).toEqual(dia(12));
    });

    it('un kilometraje ya alcanzado no se corrige', () => {
      const r = proyectarVencimiento({
        ...base,
        odometerKm: 10_600,
        kmPorDia: 50,
        correccion: correccion(5),
      });
      expect(r.porKilometraje).toEqual(HOY);
      expect(r.correccion).toBeNull();
    });

    it('sin consumo no hay fecha que corregir', () => {
      const r = proyectarVencimiento({
        ...base,
        kmPorDia: null,
        correccion: correccion(5),
      });
      expect(r.porKilometraje).toBeNull();
      expect(r.correccion).toBeNull();
    });
  });
});
