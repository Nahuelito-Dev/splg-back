import { DIAS_DE_TALLER_POR_OMISION } from './dias-de-taller';
import {
  diaDelVencimiento,
  diasHasta,
  enumerarVentanas,
  evaluarVentanas,
  VentanaCandidata,
} from './ventanas-de-taller';

// 30/10/2026 es viernes; 15:00 UTC son las 12:00 en Argentina.
const HOY = new Date('2026-10-30T15:00:00Z');
const BASE = {
  hoy: HOY,
  minLeadDays: 1,
  horizonDays: 30,
  workshopStartHour: 8,
  workshopEndHour: 13,
  workshopDays: 0b1111111, // todos los días: los casos de abajo cuentan días corridos
};

describe('enumerarVentanas', () => {
  it('una por día, desde mañana hasta el día anterior al vencimiento', () => {
    const v = enumerarVentanas({
      ...BASE,
      proyectado: new Date('2026-11-04T03:00:00Z'),
    });
    expect(v.map((x) => x.day)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
  });

  it('las horas son las del taller en hora argentina', () => {
    const [v] = enumerarVentanas({
      ...BASE,
      proyectado: new Date('2026-11-10T03:00:00Z'),
    });
    expect(v.start.toISOString()).toBe('2026-10-31T11:00:00.000Z'); // 08:00 ART
    expect(v.end.toISOString()).toBe('2026-10-31T16:00:00.000Z'); // 13:00 ART
  });

  it('respeta el horizonte aunque el vencimiento esté más lejos', () => {
    const v = enumerarVentanas({
      ...BASE,
      horizonDays: 3,
      proyectado: new Date('2027-03-01T03:00:00Z'),
    });
    expect(v.map((x) => x.day)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('el aviso mínimo corre el primer día', () => {
    const v = enumerarVentanas({
      ...BASE,
      minLeadDays: 3,
      proyectado: new Date('2026-11-10T03:00:00Z'),
    });
    expect(v[0].day).toBe('2026-11-02');
  });

  it('un vencimiento vencido o inmediato no tiene ventanas a tiempo: quedan sólo las urgentes', () => {
    for (const proyectado of ['2026-10-20T03:00:00Z', '2026-10-31T15:00:00Z']) {
      const v = enumerarVentanas({ ...BASE, proyectado: new Date(proyectado) });
      expect(v.length).toBeGreaterThan(0);
      expect(v.every((x) => x.urgent)).toBe(true);
    }
  });

  it('sin horizonte para ninguna no queda nada', () => {
    expect(
      enumerarVentanas({
        ...BASE,
        minLeadDays: 5,
        horizonDays: 2,
        proyectado: new Date('2026-10-20T03:00:00Z'),
      }),
    ).toEqual([]);
  });
});

describe('días hábiles y urgencia', () => {
  it('por omisión (lunes a sábado) no ofrece los domingos', () => {
    const v = enumerarVentanas({
      ...BASE,
      workshopDays: DIAS_DE_TALLER_POR_OMISION,
      proyectado: new Date('2026-11-05T03:00:00Z'),
    });
    expect(v.map((x) => x.day)).toEqual([
      '2026-10-31',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('no ofrece un feriado nacional', () => {
    // 23/11/2026 es feriado (trasladable del 20/11).
    const v = enumerarVentanas({
      ...BASE,
      hoy: new Date('2026-11-20T15:00:00Z'),
      workshopDays: DIAS_DE_TALLER_POR_OMISION,
      proyectado: new Date('2026-11-26T03:00:00Z'),
    });
    expect(v.map((x) => x.day)).not.toContain('2026-11-23');
    expect(v.map((x) => x.day)).toContain('2026-11-24');
  });

  it('respeta los días elegidos del taller', () => {
    const soloLunesYMiercoles = 0b0001010;
    const v = enumerarVentanas({
      ...BASE,
      workshopDays: soloLunesYMiercoles,
      proyectado: new Date('2026-11-12T03:00:00Z'),
    });
    expect(v.map((x) => x.day)).toEqual([
      '2026-11-02',
      '2026-11-04',
      '2026-11-09',
      '2026-11-11',
    ]);
  });

  it('una tarea vencida se negocia igual: ventanas desde el primer día hábil, marcadas urgentes', () => {
    const v = enumerarVentanas({
      ...BASE,
      workshopDays: DIAS_DE_TALLER_POR_OMISION,
      proyectado: new Date('2026-10-20T03:00:00Z'),
    });
    expect(v[0].day).toBe('2026-10-31');
    expect(v.every((x) => x.urgent === true)).toBe(true);
  });

  it('con margen no hay ventanas urgentes', () => {
    const v = enumerarVentanas({
      ...BASE,
      proyectado: new Date('2026-11-10T03:00:00Z'),
    });
    expect(v.some((x) => x.urgent)).toBe(false);
  });

  it('lo urgente se ofrece por fecha, no por demanda', () => {
    const candidatas = [
      {
        day: '2026-10-31',
        start: new Date('2026-10-31T11:00:00Z'),
        end: new Date('2026-10-31T16:00:00Z'),
        urgent: true,
      },
      {
        day: '2026-11-02',
        start: new Date('2026-11-02T11:00:00Z'),
        end: new Date('2026-11-02T16:00:00Z'),
        urgent: true,
      },
    ];
    const r = evaluarVentanas(
      candidatas,
      (d) => (d === '2026-10-31' ? 99 : 0),
      () => null,
      1,
      1,
    );
    expect(r.evaluadas[0]).toMatchObject({ urgent: true, offered: true });
    expect(r.evaluadas[0].start.startsWith('2026-10-31')).toBe(true);
  });
});

describe('evaluarVentanas', () => {
  const ventana = (day: string): VentanaCandidata => ({
    day,
    start: new Date(`${day}T11:00:00Z`),
    end: new Date(`${day}T16:00:00Z`),
  });
  const candidatas = [
    ventana('2026-11-02'),
    ventana('2026-11-03'),
    ventana('2026-11-04'),
    ventana('2026-11-05'),
  ];

  it('ofrece primero los días de menor demanda (evita los picos)', () => {
    const demanda = {
      '2026-11-02': 9,
      '2026-11-03': 2,
      '2026-11-04': 5,
      '2026-11-05': 1,
    };
    const r = evaluarVentanas(
      candidatas,
      (d) => demanda[d as keyof typeof demanda],
      () => null,
      1,
      2,
    );
    expect(r.ofrecidas).toBe(2);
    expect(r.evaluadas.slice(0, 2).map((w) => w.start.slice(0, 10))).toEqual([
      '2026-11-05',
      '2026-11-03',
    ]);
    expect(r.evaluadas.slice(0, 2).every((w) => w.offered)).toBe(true);
    expect(r.evaluadas[2]).toMatchObject({
      offered: false,
      discardReason: 'not_selected',
    });
  });

  it('a igual demanda gana el día más próximo', () => {
    const r = evaluarVentanas(
      candidatas,
      () => 3,
      () => null,
      1,
      1,
    );
    expect(r.evaluadas[0].start.slice(0, 10)).toBe('2026-11-02');
  });

  it('descarta con motivo las que dejarían la zona bajo el mínimo', () => {
    const unidades = (d: string) => (d === '2026-11-03' ? 0 : 2);
    const r = evaluarVentanas(candidatas, () => 0, unidades, 1, 10);
    const descartada = r.evaluadas.find((w) =>
      w.start.startsWith('2026-11-03'),
    );
    expect(descartada).toMatchObject({
      offered: false,
      discardReason: 'coverage',
      unitsLeft: 0,
    });
    expect(r.descartadasPorCobertura).toBe(1);
    expect(r.ofrecidas).toBe(3);
  });

  it('sin zona (unidades null) no hay restricción de cobertura', () => {
    const r = evaluarVentanas(
      candidatas,
      () => 0,
      () => null,
      5,
      10,
    );
    expect(r.descartadasPorCobertura).toBe(0);
    expect(r.ofrecidas).toBe(4);
  });

  it('si toda ventana deja la zona bajo el mínimo no ofrece ninguna', () => {
    const r = evaluarVentanas(
      candidatas,
      () => 0,
      () => 0,
      1,
      3,
    );
    expect(r.ofrecidas).toBe(0);
    expect(r.descartadasPorCobertura).toBe(4);
  });

  it('redondea la demanda del cuadro a dos decimales', () => {
    const r = evaluarVentanas(
      [candidatas[0]],
      () => 1 / 3,
      () => null,
      1,
      1,
    );
    expect(r.evaluadas[0].demand).toBe(0.33);
  });
});

describe('un vencimiento de calendario (medianoche UTC)', () => {
  it('es el día que dice, no el anterior en hora argentina', () => {
    expect(diaDelVencimiento(new Date('2026-11-14T00:00:00.000Z'))).toBe(
      '2026-11-14',
    );
    expect(diaDelVencimiento(new Date('2026-11-14T15:00:00.000Z'))).toBe(
      '2026-11-14',
    );
    expect(diaDelVencimiento(new Date('2026-11-14T02:00:00.000Z'))).toBe(
      '2026-11-13',
    );
  });

  it('las ventanas llegan hasta el día anterior a ese día', () => {
    const v = enumerarVentanas({
      ...BASE,
      proyectado: new Date('2026-11-03T00:00:00.000Z'),
    });
    expect(v.map((x) => x.day)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('los días que faltan cuentan hasta ese día', () => {
    expect(diasHasta(HOY, new Date('2026-11-14T00:00:00.000Z'))).toBe(15);
  });
});

describe('diasHasta', () => {
  it('cuenta días argentinos', () => {
    expect(diasHasta(HOY, new Date('2026-11-04T15:00:00Z'))).toBe(5);
    expect(diasHasta(HOY, new Date('2026-10-28T15:00:00Z'))).toBe(-2);
  });
});
