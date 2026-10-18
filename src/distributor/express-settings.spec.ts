import {
  dentroDelHorarioExpress,
  expressSettingsDesde,
  expressSettingsPorDefecto,
  minutoDelDiaArgentino,
  sonLosDeOmisionExpress,
} from './express-settings';

describe('express-settings (CU-172)', () => {
  it('sin configuración la modalidad express está apagada', () => {
    expect(expressSettingsDesde(null)).toEqual(expressSettingsPorDefecto());
    expect(expressSettingsPorDefecto().enabled).toBe(false);
    expect(sonLosDeOmisionExpress(expressSettingsPorDefecto())).toBe(true);
  });

  it('lee lo guardado', () => {
    const s = expressSettingsDesde({
      enabled: true,
      surchargeAmount: 1500,
      maxRadiusKm: 8,
      offerTtlSeconds: 25,
      serviceFrom: '09:30',
      serviceTo: '21:00',
      estimatedMinutes: 40,
      standardEstimatedMinutes: 240,
    });
    expect(s).toEqual({
      enabled: true,
      surchargeAmount: 1500,
      maxRadiusKm: 8,
      offerTtlSeconds: 25,
      serviceFrom: '09:30',
      serviceTo: '21:00',
      estimatedMinutes: 40,
      standardEstimatedMinutes: 240,
    });
    expect(sonLosDeOmisionExpress(s)).toBe(false);
  });

  it('un valor fuera de rango o de otro tipo cae al de omisión', () => {
    const base = expressSettingsPorDefecto();
    const s = expressSettingsDesde({
      enabled: 'si',
      surchargeAmount: -5,
      maxRadiusKm: 500,
      offerTtlSeconds: 1,
      estimatedMinutes: 'rápido',
      standardEstimatedMinutes: 5,
    });
    expect(s).toEqual(base);
  });

  it('un horario invertido o malformado vuelve al de omisión (los dos extremos)', () => {
    const base = expressSettingsPorDefecto();
    expect(
      expressSettingsDesde({ serviceFrom: '22:00', serviceTo: '08:00' }),
    ).toMatchObject({
      serviceFrom: base.serviceFrom,
      serviceTo: base.serviceTo,
    });
    expect(
      expressSettingsDesde({ serviceFrom: '25:00', serviceTo: '8' }),
    ).toMatchObject({
      serviceFrom: base.serviceFrom,
      serviceTo: base.serviceTo,
    });
  });

  describe('horario de servicio (hora argentina, UTC-3)', () => {
    const horario = { serviceFrom: '08:00', serviceTo: '20:00' };

    it('convierte el instante a minutos del día argentino', () => {
      expect(minutoDelDiaArgentino(new Date('2026-10-17T11:00:00Z'))).toBe(
        8 * 60,
      );
      // 02:30 UTC es 23:30 del día anterior en Argentina.
      expect(minutoDelDiaArgentino(new Date('2026-10-17T02:30:00Z'))).toBe(
        23 * 60 + 30,
      );
    });

    it('incluye el inicio y excluye el fin', () => {
      expect(
        dentroDelHorarioExpress(horario, new Date('2026-10-17T11:00:00Z')),
      ).toBe(true); // 08:00 ART
      expect(
        dentroDelHorarioExpress(horario, new Date('2026-10-17T22:59:00Z')),
      ).toBe(true); // 19:59 ART
      expect(
        dentroDelHorarioExpress(horario, new Date('2026-10-17T23:00:00Z')),
      ).toBe(false); // 20:00 ART
      expect(
        dentroDelHorarioExpress(horario, new Date('2026-10-17T10:59:00Z')),
      ).toBe(false); // 07:59 ART
    });
  });
});
