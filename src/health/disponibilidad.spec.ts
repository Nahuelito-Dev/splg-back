import {
  BLOQUE_MS,
  BLOQUES_POR_DIA,
  Muestras,
  bloqueDelDia,
  calcularHistorial,
  campoDeMuestra,
  claveDeDia,
  inicioDeBloque,
} from './disponibilidad';
import { COMPONENTES, Componente } from './componentes';

// 2026-11-22 15:00 en Argentina = 18:00 UTC.
const AHORA = Date.parse('2026-11-22T18:00:00Z');
const DIA_MS = 24 * 60 * 60_000;

/** Muestras de un día argentino: `ok` para todos los bloques salvo los pedidos. */
function diaCompleto(
  componente: Componente,
  opciones: { hasta?: number; caidos?: number[]; ausentes?: number[] } = {},
): Map<string, boolean> {
  const mapa = new Map<string, boolean>();
  const hasta = opciones.hasta ?? BLOQUES_POR_DIA;
  for (let b = 0; b < hasta; b++) {
    if (opciones.ausentes?.includes(b)) continue;
    mapa.set(campoDeMuestra(componente, b), !opciones.caidos?.includes(b));
  }
  return mapa;
}

function muestrasDe(porDia: Record<string, Map<string, boolean>>): Muestras {
  return new Map(Object.entries(porDia));
}

describe('helpers de tiempo (hora de Argentina)', () => {
  it('el día arranca a las 03:00 UTC', () => {
    expect(claveDeDia(Date.parse('2026-11-22T02:59:00Z'))).toBe('2026-11-21');
    expect(claveDeDia(Date.parse('2026-11-22T03:00:00Z'))).toBe('2026-11-22');
    expect(bloqueDelDia(Date.parse('2026-11-22T03:00:00Z'))).toBe(0);
    expect(bloqueDelDia(Date.parse('2026-11-23T02:59:59Z'))).toBe(287);
  });

  it('inicioDeBloque trunca a 5 minutos', () => {
    const ts = Date.parse('2026-11-22T18:07:31Z');
    expect(inicioDeBloque(ts)).toBe(Date.parse('2026-11-22T18:05:00Z'));
  });
});

describe('calcularHistorial', () => {
  it('sin ninguna muestra registrada: todos los días en gris y sin disponibilidad', () => {
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: null,
      muestras: new Map(),
    });
    for (const c of COMPONENTES) {
      expect(h[c].dias).toHaveLength(90);
      expect(h[c].dias.every((d) => d.estado === 'sin-datos')).toBe(true);
      expect(h[c].disponibilidad).toBeNull();
      expect(h[c].incidentes).toEqual([]);
    }
  });

  it('días completos sin caídas: verde, 100 % y sin incidentes', () => {
    const primera = Date.parse('2026-11-20T03:00:00Z');
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: primera,
      muestras: muestrasDe({
        '2026-11-20': diaCompleto('postgres'),
        '2026-11-21': diaCompleto('postgres'),
        '2026-11-22': diaCompleto('postgres', { hasta: 180 }),
      }),
    });
    const dias = h.postgres.dias;
    expect(dias[89]).toMatchObject({
      fecha: '2026-11-22',
      estado: 'ok',
      disponibilidad: 100,
      minutosCaidos: 0,
    });
    expect(dias[88]).toMatchObject({ fecha: '2026-11-21', estado: 'ok' });
    expect(h.postgres.disponibilidad).toBe(100);
    expect(h.postgres.incidentes).toEqual([]);
  });

  it('los días anteriores al primer registro quedan grises y no cuentan en el porcentaje', () => {
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-22T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-22': diaCompleto('redis', { hasta: 180 }),
      }),
    });
    expect(h.redis.dias[88].estado).toBe('sin-datos');
    expect(h.redis.dias[88].disponibilidad).toBeNull();
    expect(h.redis.dias[89].estado).toBe('ok');
    expect(h.redis.disponibilidad).toBe(100);
  });

  it('el primer día cuenta sólo desde el bloque de la primera muestra', () => {
    // Primer registro a las 12:00 AR (bloque 144); antes no hay datos pero no es caída.
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-22T15:00:00Z'),
      muestras: muestrasDe({
        '2026-11-22': new Map(
          [...diaCompleto('api', { hasta: 180 })].filter(
            ([campo]) => Number(campo.split(':')[1]) >= 144,
          ),
        ),
      }),
    });
    expect(h.api.dias[89]).toMatchObject({
      estado: 'ok',
      disponibilidad: 100,
      minutosCaidos: 0,
    });
  });

  it('un tramo caído parcial da amarillo, minutos caídos e incidente con desde/hasta', () => {
    // Caído de 10:00 a 10:20 AR = bloques 120..123 (4 bloques = 20 min).
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-21T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-21': diaCompleto('postgres', { caidos: [120, 121, 122, 123] }),
        '2026-11-22': diaCompleto('postgres', { hasta: 180 }),
      }),
    });
    const dia = h.postgres.dias[88];
    expect(dia.estado).toBe('parcial');
    expect(dia.minutosCaidos).toBe(20);
    expect(dia.disponibilidad).toBe(98.61); // 284/288 truncado
    expect(h.postgres.incidentes).toEqual([
      {
        fecha: '2026-11-21',
        desde: '10:00',
        hasta: '10:20',
        tipo: 'caido',
        minutos: 20,
      },
    ]);
  });

  it('un día con más del 5 % caído se pinta rojo', () => {
    const caidos = Array.from({ length: 30 }, (_, i) => 100 + i);
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-21T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-21': diaCompleto('storage', { caidos }),
      }),
    });
    expect(h.storage.dias[88].estado).toBe('caido');
  });

  it('los huecos sin muestras cuentan como caída: servidor apagado', () => {
    // Sin muestras de las 00:00 a las 01:00 AR (bloques 0..11).
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-21T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-21': diaCompleto('api', {
          ausentes: Array.from({ length: 12 }, (_, i) => i),
        }),
      }),
    });
    expect(h.api.dias[88].minutosCaidos).toBe(60);
    expect(h.api.incidentes[0]).toEqual({
      fecha: '2026-11-21',
      desde: '00:00',
      hasta: '01:00',
      tipo: 'sin-datos-servidor',
      minutos: 60,
    });
  });

  it('un día entero sin muestras (después del primer registro) es una caída del 0 %', () => {
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-20T03:00:00Z'),
      muestras: muestrasDe({ '2026-11-20': diaCompleto('api') }),
    });
    expect(h.api.dias[88]).toMatchObject({
      fecha: '2026-11-21',
      estado: 'caido',
      disponibilidad: 0,
      minutosCaidos: 1440,
    });
    expect(h.api.incidentes.find((i) => i.fecha === '2026-11-21')).toEqual({
      fecha: '2026-11-21',
      desde: '00:00',
      hasta: '24:00',
      tipo: 'sin-datos-servidor',
      minutos: 1440,
    });
  });

  it('caído explícito y hueco consecutivos son dos incidentes distintos', () => {
    const h = calcularHistorial({
      ahora: AHORA,
      primeraMuestra: Date.parse('2026-11-21T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-21': diaCompleto('redis', {
          caidos: [10, 11],
          ausentes: [12, 13],
        }),
      }),
    });
    const delDia = h.redis.incidentes.filter((i) => i.fecha === '2026-11-21');
    expect(delDia.map((i) => i.tipo)).toEqual(['caido', 'sin-datos-servidor']);
  });

  it('el bloque en curso (que todavía no terminó) no cuenta', () => {
    // A las 15:02 AR el bloque 180 (15:00) no terminó: no es una caída sin muestra.
    const h = calcularHistorial({
      ahora: Date.parse('2026-11-22T18:02:00Z'),
      primeraMuestra: Date.parse('2026-11-22T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-22': diaCompleto('api', { hasta: 180 }),
      }),
    });
    expect(h.api.dias[89].minutosCaidos).toBe(0);
    expect(h.api.dias[89].estado).toBe('ok');
  });

  it('el porcentaje del período se trunca: nunca muestra 100 con una caída', () => {
    const h = calcularHistorial({
      ahora: AHORA - 2 * DIA_MS + BLOQUE_MS * 0,
      primeraMuestra: Date.parse('2026-11-19T03:00:00Z'),
      muestras: muestrasDe({
        '2026-11-19': diaCompleto('api', { caidos: [0] }),
        '2026-11-20': diaCompleto('api'),
      }),
    });
    expect(h.api.disponibilidad).toBeLessThan(100);
    expect(h.api.disponibilidad).toBe(99.78);
  });
});
