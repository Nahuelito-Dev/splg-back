import {
  diaArgentino,
  diaDeLaSemana,
  inicioDelDiaArgentino,
  lunesDeLaSemana,
  primerDiaDelMes,
  primerDiaDelMesSiguiente,
  rangoDeDiasArgentinos,
  rangoDelDiaArgentino,
  sumarDias,
  truncarEnArgentinaSql,
} from './dias-argentina';

describe('dias-argentina', () => {
  it('el día arranca a las 03:00 UTC y dura 24 horas', () => {
    const r = rangoDelDiaArgentino('2026-07-07');
    expect(r?.desde.toISOString()).toBe('2026-07-07T03:00:00.000Z');
    expect(r?.hasta.toISOString()).toBe('2026-07-08T03:00:00.000Z');
  });

  it('con from = to el rango es un día completo (to inclusivo)', () => {
    const r = rangoDeDiasArgentinos('2026-07-07', '2026-07-07');
    expect(r?.desde.toISOString()).toBe('2026-07-07T03:00:00.000Z');
    expect(r?.hasta.toISOString()).toBe('2026-07-08T03:00:00.000Z');
  });

  it('el rango de varios días llega hasta el fin del último', () => {
    const r = rangoDeDiasArgentinos('2026-07-07', '2026-07-09');
    expect(r?.hasta.toISOString()).toBe('2026-07-10T03:00:00.000Z');
  });

  it('rechaza días inválidos', () => {
    expect(inicioDelDiaArgentino('hola')).toBeNull();
    expect(inicioDelDiaArgentino('2026-02-30')).toBeNull();
    expect(rangoDeDiasArgentinos('2026-07-07', 'x')).toBeNull();
  });

  it('un instante a las 22:00 ART del 7/7 sigue siendo 7/7 (01:00 UTC del 8/7)', () => {
    expect(diaArgentino(new Date('2026-07-08T01:00:00Z'))).toBe('2026-07-07');
    expect(diaArgentino(new Date('2026-07-08T03:00:00Z'))).toBe('2026-07-08');
  });

  it('suma días, cruza meses y calcula día de semana y mes', () => {
    expect(sumarDias('2026-07-31', 1)).toBe('2026-08-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(diaDeLaSemana('2026-07-05')).toBe(0);
    expect(primerDiaDelMes('2026-07-17')).toBe('2026-07-01');
    expect(primerDiaDelMesSiguiente('2026-12-17')).toBe('2027-01-01');
  });

  it('lunesDeLaSemana devuelve el lunes ISO', () => {
    expect(lunesDeLaSemana('2026-07-12')).toBe('2026-07-06'); // domingo
    expect(lunesDeLaSemana('2026-07-13')).toBe('2026-07-13'); // lunes
    expect(lunesDeLaSemana('2026-07-08')).toBe('2026-07-06'); // miércoles
  });

  it('exige el formato exacto YYYY-MM-DD', () => {
    expect(inicioDelDiaArgentino('2026-07-07T10:00:00Z')).toBeNull();
    expect(inicioDelDiaArgentino('2026-07-07x')).toBeNull();
  });

  it('el SQL trunca el timestamptz directo en la zona argentina, sin zona de proceso', () => {
    expect(truncarEnArgentinaSql('day', 'o.x')).toBe(
      "date_trunc('day', o.x AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'",
    );
  });

  it('el SQL de agrupamiento usa la zona argentina', () => {
    expect(truncarEnArgentinaSql('week', 'o.x')).toContain(
      "AT TIME ZONE 'America/Argentina/Buenos_Aires'",
    );
  });
});
