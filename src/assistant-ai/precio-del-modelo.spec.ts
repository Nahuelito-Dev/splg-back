import {
  costoMensualEstimadoUsd,
  PRECIO_HAIKU_5_5_USD_POR_MILLON,
  PROPORCION_DE_ENTRADA_DE_UN_CHAT,
} from './precio-del-modelo';

describe('costo mensual estimado del asistente con IA (lo calcula el back)', () => {
  it('los precios de Claude Haiku 5.5 y el reparto de un chat (§6)', () => {
    expect(PRECIO_HAIKU_5_5_USD_POR_MILLON).toEqual({
      entrada: 0.1,
      salida: 0.5,
    });
    expect(PROPORCION_DE_ENTRADA_DE_UN_CHAT).toBe(0.95);
  });

  it.each([
    // tokens, min (95 % entrada + 5 % salida), max (todo salida)
    [2_000_000, 0.24, 1],
    [10_000, 0.0012, 0.005],
    [1_000_000_000, 120, 500],
    [1_234_567, 0.1481, 0.6173],
  ])('%i tokens por mes → %d / %d US$', (tokens, min, max) => {
    expect(costoMensualEstimadoUsd(tokens)).toEqual({ min, max });
  });

  it('con decimal: 3 × 0,1 de entrada no da 0,30000000000000004', () => {
    // 3.000.000 de tokens: 3 × (0,95 × 0,10 + 0,05 × 0,50) = 0,36 exacto.
    expect(costoMensualEstimadoUsd(3_000_000).min).toBe(0.36);
  });
});
