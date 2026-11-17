import {
  FrenoDeErrores,
  mensajeNormalizado,
  VENTANA_DEL_FRENO_MS,
} from './freno-de-errores';

describe('FrenoDeErrores', () => {
  it('el mismo error del mismo proceso pasa una vez cada 10 minutos', () => {
    const freno = new FrenoDeErrores();
    expect(freno.pasa('dispatch_tick', 'MP no respondió', 0)).toBe(true);
    expect(freno.pasa('dispatch_tick', 'MP no respondió', 1_000)).toBe(false);
    expect(
      freno.pasa('dispatch_tick', 'MP no respondió', VENTANA_DEL_FRENO_MS - 1),
    ).toBe(false);
    expect(
      freno.pasa('dispatch_tick', 'MP no respondió', VENTANA_DEL_FRENO_MS),
    ).toBe(true);
  });

  it('otro proceso u otro mensaje pasan', () => {
    const freno = new FrenoDeErrores();
    expect(freno.pasa('dispatch_tick', 'MP no respondió', 0)).toBe(true);
    expect(freno.pasa('route_batch_build', 'MP no respondió', 0)).toBe(true);
    expect(freno.pasa('dispatch_tick', 'Redis caído', 0)).toBe(true);
    expect(freno.pasa(null, 'Redis caído', 0)).toBe(true);
    expect(freno.pasa(null, 'Redis caído', 0)).toBe(false);
  });

  it('el mismo error con otro id o número cuenta como el mismo', () => {
    const freno = new FrenoDeErrores();
    expect(
      freno.pasa(
        'payment_inbox',
        'aviso 0af76519-16cd-43dd-8448-eb211c80319c falló tras 3 intentos',
        0,
      ),
    ).toBe(true);
    expect(
      freno.pasa(
        'payment_inbox',
        'aviso 1bf76519-16cd-43dd-8448-eb211c80319d falló tras 5 intentos',
        10,
      ),
    ).toBe(false);
    expect(
      mensajeNormalizado('pedido 12 de abc12345-0000-0000-0000-000000000000'),
    ).toBe('pedido <n> de <id>');
  });

  it('con muchas claves olvida las vencidas', () => {
    const freno = new FrenoDeErrores(100);
    for (let i = 0; i < 500; i += 1) freno.pasa(`p${'x'.repeat(i)}`, 'm', 0);
    expect(freno.pasa('nuevo', 'm', 200)).toBe(true);
    // La limpieza borró las vencidas: la primera vuelve a pasar sin esperar.
    expect(freno.pasa('p', 'm', 200)).toBe(true);
    expect(freno.pasa('nuevo', 'm', 250)).toBe(false);
  });
});
