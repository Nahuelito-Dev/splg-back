import {
  atiendeLaEmpresa,
  esFecha,
  feriadosValidos,
  type HorarioDeLaEmpresa,
  minutosHabiles,
  proximaAtencion,
  textoDeLaProximaAtencion,
} from './horario-de-la-empresa';

const ZONA = 'America/Argentina/Buenos_Aires';
/** Hora de Buenos Aires (UTC-3, sin horario de verano). */
const ba = (fechaHora: string) => new Date(`${fechaHora}-03:00`);

// Lunes a viernes de 9 a 13 y de 14 a 18.
const SEMANA = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, opensAt: '09:00', closesAt: '13:00' },
  { weekday, opensAt: '14:00', closesAt: '18:00' },
]);
const h = (
  feriados: HorarioDeLaEmpresa['feriados'] = [],
): HorarioDeLaEmpresa => ({ franjas: SEMANA, feriados, zona: ZONA });

describe('horario de atención de la empresa (§8.4)', () => {
  it('atiende dentro de las franjas y no fuera, ni en un día sin atención', () => {
    // 2026-11-16 es lunes.
    expect(atiendeLaEmpresa(h(), ba('2026-11-16T10:00:00'))).toBe(true);
    expect(atiendeLaEmpresa(h(), ba('2026-11-16T13:30:00'))).toBe(false);
    expect(atiendeLaEmpresa(h(), ba('2026-11-15T10:00:00'))).toBe(false);
    expect(
      atiendeLaEmpresa(
        h([{ date: '2026-11-16', reason: 'Feriado' }]),
        ba('2026-11-16T10:00:00'),
      ),
    ).toBe(false);
  });

  it('sin franjas atiende todo el día, salvo los días sin atención', () => {
    const siempre = { franjas: [], feriados: [], zona: ZONA };
    expect(atiendeLaEmpresa(siempre, ba('2026-11-15T03:00:00'))).toBe(true);
    expect(proximaAtencion(siempre, ba('2026-11-15T03:00:00'))).toBeNull();
    const conFeriado = {
      ...siempre,
      feriados: [{ date: '2026-11-15', reason: 'Inventario' }],
    };
    expect(atiendeLaEmpresa(conFeriado, ba('2026-11-15T03:00:00'))).toBe(false);
    expect(
      proximaAtencion(conFeriado, ba('2026-11-15T03:00:00'))?.toISOString(),
    ).toBe(ba('2026-11-16T00:00:00').toISOString());
  });

  it('la próxima atención saltea el corte del mediodía, el fin de semana y los feriados', () => {
    expect(proximaAtencion(h(), ba('2026-11-16T13:30:00'))?.toISOString()).toBe(
      ba('2026-11-16T14:00:00').toISOString(),
    );
    expect(proximaAtencion(h(), ba('2026-11-14T20:00:00'))?.toISOString()).toBe(
      ba('2026-11-16T09:00:00').toISOString(),
    );
    expect(
      proximaAtencion(
        h([{ date: '2026-11-16', reason: 'Feriado' }]),
        ba('2026-11-14T20:00:00'),
      )?.toISOString(),
    ).toBe(ba('2026-11-17T09:00:00').toISOString());
    expect(proximaAtencion(h(), ba('2026-11-16T10:00:00'))).toBeNull();
  });

  it('minutos hábiles: sólo cuenta lo que cae en horario', () => {
    // Viernes 17:50 → lunes 9:10: 10 min del viernes + 10 del lunes.
    expect(
      minutosHabiles(h(), ba('2026-11-20T17:50:00'), ba('2026-11-23T09:10:00')),
    ).toBe(20);
    // Cruzando el corte del mediodía: 12:50 → 14:10 = 10 + 10.
    expect(
      minutosHabiles(h(), ba('2026-11-16T12:50:00'), ba('2026-11-16T14:10:00')),
    ).toBe(20);
    // Todo con la empresa cerrada: 0 aunque pasen horas.
    expect(
      minutosHabiles(h(), ba('2026-11-14T10:00:00'), ba('2026-11-15T22:00:00')),
    ).toBe(0);
    // Un feriado en el medio no cuenta.
    expect(
      minutosHabiles(
        h([{ date: '2026-11-16', reason: 'Feriado' }]),
        ba('2026-11-16T10:00:00'),
        ba('2026-11-17T09:30:00'),
      ),
    ).toBe(30);
    expect(
      minutosHabiles(h(), ba('2026-11-16T10:00:00'), ba('2026-11-16T09:00:00')),
    ).toBe(0);
    // Sin franjas: reloj corrido.
    expect(
      minutosHabiles(
        { franjas: [], feriados: [], zona: ZONA },
        ba('2026-11-16T10:00:00'),
        ba('2026-11-16T12:30:00'),
      ),
    ).toBe(150);
  });

  it('minutos hábiles: igual que contar minuto a minuto con `atiendeLaEmpresa` (franjas, feriados, fin de semana)', () => {
    const conFeriado = h([{ date: '2026-11-18', reason: 'Feriado' }]);
    /** El oráculo: cuántos minutos enteros atiende entre dos instantes. */
    const contando = (desde: Date, hasta: Date) => {
      let n = 0;
      for (let t = desde.getTime(); t < hasta.getTime(); t += 60_000) {
        if (atiendeLaEmpresa(conFeriado, new Date(t))) n++;
      }
      return n;
    };
    // Pseudoazar fijo: rangos de hasta 9 días que arrancan en minutos enteros.
    let semilla = 7;
    const azar = () => {
      semilla = (semilla * 16807) % 2147483647;
      return semilla / 2147483647;
    };
    const base = ba('2026-11-13T00:00:00').getTime();
    for (let i = 0; i < 40; i++) {
      const desde = new Date(base + Math.floor(azar() * 9 * 1440) * 60_000);
      const hasta = new Date(
        desde.getTime() + Math.floor(azar() * 9 * 1440) * 60_000,
      );
      expect(minutosHabiles(conFeriado, desde, hasta)).toBe(
        contando(desde, hasta),
      );
    }
  });

  it('minutos hábiles con tope: corta apenas lo supera (para saber si pasó un objetivo)', () => {
    const desde = ba('2026-11-16T09:00:00');
    const hasta = ba('2027-05-16T09:00:00');
    const entero = minutosHabiles(h(), desde, hasta);
    const cortado = minutosHabiles(h(), desde, hasta, 30);
    expect(cortado).toBeGreaterThan(30);
    expect(cortado).toBeLessThan(entero);
    // Si no llega al tope, da lo mismo que sin tope.
    expect(minutosHabiles(h(), desde, ba('2026-11-16T09:20:00'), 30)).toBe(20);
  });

  it('minutos hábiles en una zona con cambio de hora: no cuenta dos veces la hora repetida', () => {
    // Nueva York vuelve a la hora estándar el 01/11/2026 a las 2:00 (se repite la 1:00).
    const nyc = {
      franjas: [] as HorarioDeLaEmpresa['franjas'],
      feriados: [],
      zona: 'America/New_York',
    };
    const desde = new Date('2026-10-31T04:00:00Z'); // 31/10 00:00 local (EDT)
    const hasta = new Date('2026-11-03T05:00:00Z'); // 03/11 00:00 local (EST)
    expect(minutosHabiles(nyc, desde, hasta)).toBe(
      (hasta.getTime() - desde.getTime()) / 60_000,
    );
  });

  it('el texto de la próxima atención', () => {
    const ahora = ba('2026-11-16T13:30:00');
    expect(
      textoDeLaProximaAtencion(ba('2026-11-16T14:00:00'), ZONA, ahora),
    ).toBe('hoy a las 14:00');
    expect(
      textoDeLaProximaAtencion(ba('2026-11-17T09:00:00'), ZONA, ahora),
    ).toBe('mañana a las 09:00');
    expect(
      textoDeLaProximaAtencion(ba('2026-11-19T09:00:00'), ZONA, ahora),
    ).toBe('el jueves 19/11 a las 09:00');
  });

  it('fechas y días sin atención válidos', () => {
    expect(esFecha('2026-02-28')).toBe(true);
    expect(esFecha('2026-02-30')).toBe(false);
    expect(esFecha('26-2-1')).toBe(false);
    expect(feriadosValidos([{ date: '2026-12-25', reason: 'Navidad' }])).toBe(
      true,
    );
    expect(
      feriadosValidos([
        { date: '2026-12-25', reason: 'Navidad' },
        { date: '2026-12-25', reason: 'Otra' },
      ]),
    ).toBe(false);
    expect(feriadosValidos([{ date: '2026-12-25', reason: ' ' }])).toBe(false);
  });
});
