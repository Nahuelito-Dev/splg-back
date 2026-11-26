import { exploradorHabilitado, opcionesDeGraphql } from './opciones-de-graphql';

describe('opcionesDeGraphql', () => {
  it.each(['development', 'test'])(
    'con NODE_ENV=%s hay explorador e introspección',
    (NODE_ENV) => {
      const opciones = opcionesDeGraphql({ NODE_ENV });
      expect(opciones.introspection).toBe(true);
      expect(opciones.graphiql).toBe(true);
    },
  );

  it.each([['production'], [undefined], ['staging']])(
    'con NODE_ENV=%s, apagados (falla cerrado)',
    (NODE_ENV) => {
      expect(exploradorHabilitado({ NODE_ENV })).toBe(false);
      const opciones = opcionesDeGraphql({ NODE_ENV });
      expect(opciones.introspection).toBe(false);
      expect(opciones.graphiql).toBe(false);
      expect(opciones.playground).toBe(false);
    },
  );

  it('siempre bajo el prefijo global, con CSRF y sin stack en los errores', () => {
    const opciones = opcionesDeGraphql({ NODE_ENV: 'development' });
    expect(opciones.path).toBe('/graphql');
    expect(opciones.useGlobalPrefix).toBe(true);
    expect(opciones.csrfPrevention).toBe(true);
    expect(opciones.includeStacktraceInErrorResponses).toBe(false);
    expect(opciones.validationRules).toHaveLength(3);
  });
});
