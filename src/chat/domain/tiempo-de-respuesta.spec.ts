import type { HorarioDeLaEmpresa } from './horario-de-la-empresa';
import {
  duracionEnTexto,
  historiaDeRespuestas,
  minutosParaMostrar,
  tiempoEsperado,
} from './tiempo-de-respuesta';

/** Hora argentina (UTC−3) a instante. */
const ar = (diaYHora: string) => new Date(`${diaYHora}:00-03:00`);
const ZONA = 'America/Argentina/Buenos_Aires';
// Lunes a viernes de 8 a 12.
const HORARIO: HorarioDeLaEmpresa = {
  franjas: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    opensAt: '08:00',
    closesAt: '12:00',
  })),
  feriados: [],
  zona: ZONA,
};
// Martes 17/11/2026 a las 10, en horario.
const EN_HORARIO = ar('2026-11-17T10:00');

const diez = (minutos: number) => Array.from({ length: 10 }, () => minutos);

describe('tiempo de respuesta esperado (7c)', () => {
  it('con 10 o más respondidas, la mediana de la historia', () => {
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([...diez(7), 30]),
      objetivoMinutos: 45,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect(t).toEqual({
      enabled: true,
      openNow: true,
      minutes: 7,
      basis: 'history',
      nextOpenAt: null,
      text: 'Solemos responder en ~7 min',
    });
  });

  it('con menos de 10 respondidas, el objetivo de la empresa (pocos datos)', () => {
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      objetivoMinutos: 30,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect([t.minutes, t.basis, t.text]).toEqual([
      30,
      'target',
      'Solemos responder en ~30 min',
    ]);
  });

  it('sin ninguna respondida, también el objetivo', () => {
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([]),
      objetivoMinutos: 90,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect([t.minutes, t.basis, t.text]).toEqual([
      120,
      'target',
      'Solemos responder en ~2 h',
    ]);
  });

  it('no es optimista: las que esperan entran con lo que llevan esperando, en la mediana de las dos juntas', () => {
    // 10 respondidas a los 5 minutos y 11 esperando hace 60: la mediana de
    // las 21 es 60, no 5.
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas(
        diez(5),
        Array.from({ length: 11 }, () => 60),
      ),
      objetivoMinutos: 30,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect([t.minutes, t.basis, t.text]).toEqual([
      60,
      'history',
      'Solemos responder en ~1 h',
    ]);
  });

  it('pocas respondidas pero muchas esperando: también la mediana de las dos juntas', () => {
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([4, 6], diez(45)),
      objetivoMinutos: 30,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect([t.minutes, t.basis]).toEqual([45, 'history']);
  });

  it('pocos datos y las que esperan ya llevan más que el objetivo: no promete menos de lo que esperan', () => {
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([2], [50, 70]),
      objetivoMinutos: 30,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect([t.minutes, t.basis]).toEqual([60, 'waiting']);
    // Si esperan menos que el objetivo, el objetivo.
    const corta = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([2], [10]),
      objetivoMinutos: 30,
      horario: HORARIO,
      ahora: EN_HORARIO,
    });
    expect([corta.minutes, corta.basis]).toEqual([30, 'target']);
  });

  it('fuera de horario: cuándo vuelve a atender, sin minutos', () => {
    // Martes 17/11 a las 15: vuelve el miércoles a las 8.
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas(diez(5)),
      objetivoMinutos: 30,
      horario: HORARIO,
      ahora: ar('2026-11-17T15:00'),
    });
    expect(t).toEqual({
      enabled: true,
      openNow: false,
      minutes: null,
      basis: null,
      nextOpenAt: ar('2026-11-18T08:00'),
      text: 'Ahora estamos fuera de horario. Te respondemos mañana a las 08:00.',
    });
  });

  it('en un día sin atención, salta al siguiente hábil', () => {
    const t = tiempoEsperado({
      habilitado: true,
      historia: historiaDeRespuestas([]),
      objetivoMinutos: 30,
      horario: {
        ...HORARIO,
        feriados: [{ date: '2026-11-17', reason: 'Inventario' }],
      },
      ahora: EN_HORARIO,
    });
    expect([t.openNow, t.nextOpenAt]).toEqual([false, ar('2026-11-18T08:00')]);
  });

  it('apagado: nada que mostrar, aunque haya historia', () => {
    expect(
      tiempoEsperado({
        habilitado: false,
        historia: historiaDeRespuestas(diez(5)),
        objetivoMinutos: 30,
        horario: HORARIO,
        ahora: EN_HORARIO,
      }),
    ).toEqual({
      enabled: false,
      openNow: false,
      minutes: null,
      basis: null,
      nextOpenAt: null,
      text: null,
    });
  });

  it('redondeo para mostrar: minuto de arriba hasta la hora, horas después', () => {
    expect([0, 0.2, 12.1, 59, 60, 89, 91, 150].map(minutosParaMostrar)).toEqual(
      [1, 1, 13, 59, 60, 60, 120, 180],
    );
    expect([duracionEnTexto(12), duracionEnTexto(120)]).toEqual([
      '12 min',
      '2 h',
    ]);
  });
});
