import { estaAbierto, franjasValidas } from './horario';

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
});
