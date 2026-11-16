import { huellaDeError, normalizarMensaje } from './huella-de-error';

describe('huella de un error', () => {
  const base = {
    origen: 'process' as const,
    donde: 'stock_reconciliation',
    mensaje: 'No se pudo leer el pedido 0b8e6c1a-1111-4a2b-9c3d-4e5f6a7b8c9d',
  };

  it('son 16 hexadecimales', () => {
    expect(huellaDeError(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('el mismo error con otros ids, números, fechas o textos da la misma huella', () => {
    const otra = {
      ...base,
      mensaje: 'No se pudo leer el pedido 9f1e2d3c-2222-4b5a-8c7d-6e5f4a3b2c1d',
    };
    expect(huellaDeError(otra)).toBe(huellaDeError(base));
    expect(
      normalizarMensaje(
        'Timeout de 5000 ms el 2026-11-14T12:00:00Z en «Empresa A»',
      ),
    ).toBe(normalizarMensaje('Timeout de 300 ms el 2026-11-13 en «Otra»'));
  });

  it('otro proceso, otro origen, otra excepción u otro mensaje dan otra huella', () => {
    const h = huellaDeError(base);
    expect(huellaDeError({ ...base, donde: 'fleet_alerts' })).not.toBe(h);
    expect(huellaDeError({ ...base, origen: 'http' })).not.toBe(h);
    expect(huellaDeError({ ...base, nombre: 'QueryFailedError' })).not.toBe(h);
    expect(huellaDeError({ ...base, mensaje: 'Otra cosa' })).not.toBe(h);
  });
});
