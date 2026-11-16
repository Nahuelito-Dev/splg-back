import {
  CONSUMO_MAXIMO_KG_MES,
  CONSUMO_MINIMO_KG_MES,
  consumoEnRango,
  estimarProximaRecompra,
  kilosPorMes,
} from './consumption';

describe('kilosPorMes', () => {
  it('multiplica el peso del tipo por las garrafas al mes', () => {
    expect(kilosPorMes(10, 2)).toBe(20);
    expect(kilosPorMes(45, 0.5)).toBe(22.5);
  });

  it('redondea a dos decimales', () => {
    expect(kilosPorMes(10, 0.333)).toBe(3.33);
  });
});

describe('consumoEnRango', () => {
  it('acepta los extremos del rango', () => {
    expect(consumoEnRango(CONSUMO_MINIMO_KG_MES)).toBe(true);
    expect(consumoEnRango(CONSUMO_MAXIMO_KG_MES)).toBe(true);
  });

  it('rechaza lo que queda fuera', () => {
    expect(consumoEnRango(CONSUMO_MINIMO_KG_MES - 0.01)).toBe(false);
    expect(consumoEnRango(CONSUMO_MAXIMO_KG_MES + 0.01)).toBe(false);
  });
});

describe('estimarProximaRecompra', () => {
  const desde = new Date('2026-10-01T00:00:00.000Z');

  it('una garrafa de 10 kg al ritmo de 10 kg por mes dura 30 días', () => {
    expect(estimarProximaRecompra(desde, 10, 10).toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
  });

  it('un consumo mayor acorta el plazo y uno menor lo alarga', () => {
    const rapido = estimarProximaRecompra(desde, 10, 20);
    const lento = estimarProximaRecompra(desde, 10, 5);
    expect(rapido.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(lento.toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });

  it('una compra de más kilos dura más', () => {
    expect(estimarProximaRecompra(desde, 30, 10).toISOString()).toBe(
      '2026-12-30T00:00:00.000Z',
    );
  });
});
