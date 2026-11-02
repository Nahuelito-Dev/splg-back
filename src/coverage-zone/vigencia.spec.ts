import { instanteDeVigencia } from './vigencia';

describe('instanteDeVigencia', () => {
  it('desde: las 00:00 ART del día (03:00Z), sin importar la TZ del proceso', () => {
    expect(instanteDeVigencia('2026-11-02', 'desde').toISOString()).toBe(
      '2026-11-02T03:00:00.000Z',
    );
  });

  it('hasta: el último milisegundo del día argentino', () => {
    expect(instanteDeVigencia('2026-11-02', 'hasta').toISOString()).toBe(
      '2026-11-03T02:59:59.999Z',
    );
  });

  it('un instante con hora no se toca', () => {
    expect(
      instanteDeVigencia('2026-11-02T10:00:00Z', 'hasta').toISOString(),
    ).toBe('2026-11-02T10:00:00.000Z');
  });

  it('un día inexistente da una fecha inválida', () => {
    expect(
      Number.isNaN(instanteDeVigencia('2026-02-30', 'desde').getTime()),
    ).toBe(true);
  });
});
