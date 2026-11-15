import {
  ContextoDeTraza,
  nuevoTraceId,
  prefijoDeTraza,
  sanearTraceId,
  traceIdDelCliente,
} from './contexto-de-traza';

describe('sanearTraceId', () => {
  it.each([
    ['prueba-o1', 'prueba-o1'],
    ['  con_espacios_afuera  ', 'con_espacios_afuera'],
    [
      '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b',
      '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b',
    ],
    ['a'.repeat(64), 'a'.repeat(64)],
  ])('acepta %s', (valor, esperado) => {
    expect(sanearTraceId(valor)).toBe(esperado);
  });

  it.each([
    ['vacío', ''],
    ['sólo espacios', '   '],
    ['65 caracteres', 'a'.repeat(65)],
    ['con espacio', 'dos palabras'],
    ['con salto de línea', 'id\nINYECTADO'],
    ['con punto', 'a.b'],
    ['con barra', 'a/b'],
    ['con acento', 'traza-ñ'],
    ['con html', '<script>'],
    ['no es texto', ['a', 'b']],
    ['indefinido', undefined],
  ])('rechaza %s', (_caso, valor) => {
    expect(sanearTraceId(valor)).toBeNull();
  });
});

describe('ContextoDeTraza', () => {
  it('fuera de una traza no hay nada', () => {
    expect(ContextoDeTraza.actual()).toBeUndefined();
    expect(ContextoDeTraza.traceIdActual()).toBeNull();
  });

  it('lo asincrónico que arranca adentro hereda la traza, y al salir se pierde', async () => {
    const visto = await ContextoDeTraza.abrir(
      { traceId: 't-1', origen: 'http' },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return ContextoDeTraza.traceIdActual();
      },
    );
    expect(visto).toBe('t-1');
    expect(ContextoDeTraza.traceIdActual()).toBeNull();
  });

  it('dos trazas concurrentes no se pisan', async () => {
    const vistas = await Promise.all(
      ['a', 'b', 'c'].map((id, i) =>
        ContextoDeTraza.abrir({ traceId: id, origen: 'http' }, async () => {
          await new Promise((r) => setTimeout(r, 15 - i * 5));
          return ContextoDeTraza.traceIdActual();
        }),
      ),
    );
    expect(vistas).toEqual(['a', 'b', 'c']);
  });

  it('el id nuevo es un uuid y el prefijo son sus 8 primeros caracteres', () => {
    const id = nuevoTraceId();
    expect(sanearTraceId(id)).toBe(id);
    expect(prefijoDeTraza(id)).toBe(`[t:${id.slice(0, 8)}]`);
    expect(prefijoDeTraza('corto')).toBe('[t:corto]');
  });
});

describe('traceIdDelCliente', () => {
  it('le pone el prefijo c- al id que manda quien llama', () => {
    expect(traceIdDelCliente('prueba-o1')).toBe('c-prueba-o1');
  });

  it('un uuid elegido afuera nunca queda igual a uno del server', () => {
    const uuid = nuevoTraceId();
    expect(traceIdDelCliente(uuid)).toBe(`c-${uuid}`);
  });

  it('sin lugar para el prefijo (63 o 64 caracteres) o inválido, no se usa', () => {
    expect(traceIdDelCliente('x'.repeat(62))).toHaveLength(64);
    expect(traceIdDelCliente('x'.repeat(63))).toBeNull();
    expect(traceIdDelCliente('con espacio')).toBeNull();
  });

  it('el prefijo del log no muestra la c-', () => {
    expect(prefijoDeTraza('c-prueba-o1')).toBe('[t:prueba-o]');
  });
});
