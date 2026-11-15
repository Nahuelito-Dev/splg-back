import { estaAbierto, franjasValidas, proximaApertura } from './horario';

const BA = 'America/Argentina/Buenos_Aires';
const semana = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: '09:00',
  closesAt: '18:00',
}));

describe('horario del chat de la plataforma', () => {
  it('sin franjas atiende siempre', () => {
    expect(estaAbierto([], BA, new Date('2026-11-15T03:00:00Z'))).toBe(true);
  });

  it('usa la hora local de la zona (UTC-3)', () => {
    // Viernes 13/11 a las 17:59 y a las 18:00 de Buenos Aires.
    expect(estaAbierto(semana, BA, new Date('2026-11-13T20:59:00Z'))).toBe(
      true,
    );
    expect(estaAbierto(semana, BA, new Date('2026-11-13T21:00:00Z'))).toBe(
      false,
    );
    // Sábado al mediodía.
    expect(estaAbierto(semana, BA, new Date('2026-11-14T15:00:00Z'))).toBe(
      false,
    );
  });

  it('rechaza franjas que cierran antes de abrir o que se solapan el mismo día', () => {
    expect(franjasValidas(semana)).toBe(true);
    expect(
      franjasValidas([{ weekday: 1, opensAt: '18:00', closesAt: '09:00' }]),
    ).toBe(false);
    expect(
      franjasValidas([
        { weekday: 1, opensAt: '09:00', closesAt: '13:00' },
        { weekday: 1, opensAt: '12:00', closesAt: '18:00' },
      ]),
    ).toBe(false);
    expect(
      franjasValidas([
        { weekday: 1, opensAt: '09:00', closesAt: '13:00' },
        { weekday: 1, opensAt: '14:00', closesAt: '18:00' },
      ]),
    ).toBe(true);
  });

  describe('próxima apertura', () => {
    it('sin franjas o abierta ahora: null', () => {
      expect(proximaApertura([], BA, new Date('2026-11-15T03:00:00Z'))).toBe(
        null,
      );
      expect(
        proximaApertura(semana, BA, new Date('2026-11-13T20:59:00Z')),
      ).toBe(null);
    });

    it('a la noche de un día de semana: al otro día a las 9 locales', () => {
      // Martes 10/11 a las 20:30 de Buenos Aires → miércoles 11/11 09:00 (12:00 UTC).
      expect(
        proximaApertura(semana, BA, new Date('2026-11-10T23:30:45Z')),
      ).toEqual(new Date('2026-11-11T12:00:00Z'));
    });

    it('antes de abrir el mismo día: hoy a las 9', () => {
      // Lunes 09/11 a las 07:10 → lunes 09:00.
      expect(
        proximaApertura(semana, BA, new Date('2026-11-09T10:10:00Z')),
      ).toEqual(new Date('2026-11-09T12:00:00Z'));
    });

    it('viernes a la tarde: salta el fin de semana hasta el lunes', () => {
      // Viernes 13/11 a las 18:00 → lunes 16/11 a las 09:00.
      expect(
        proximaApertura(semana, BA, new Date('2026-11-13T21:00:00Z')),
      ).toEqual(new Date('2026-11-16T12:00:00Z'));
    });

    it('una sola franja semanal ya pasada: la de la semana que viene', () => {
      const soloLunes = [{ weekday: 1, opensAt: '10:00', closesAt: '11:00' }];
      // Lunes 09/11 a las 11:00 (recién cerró) → lunes 16/11 a las 10:00.
      expect(
        proximaApertura(soloLunes, BA, new Date('2026-11-09T14:00:00Z')),
      ).toEqual(new Date('2026-11-16T13:00:00Z'));
    });

    it('con cambio de hora entre medio corrige con la hora local', () => {
      // Madrid pasa a horario de invierno el domingo 25/10/2026 a las 03:00.
      const lunes = [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }];
      // Sábado 24/10 12:00 local (10:00 UTC, verano) → lunes 26/10 09:00 local (08:00 UTC, invierno).
      expect(
        proximaApertura(
          lunes,
          'Europe/Madrid',
          new Date('2026-10-24T10:00:00Z'),
        ),
      ).toEqual(new Date('2026-10-26T08:00:00Z'));
    });
  });
});
