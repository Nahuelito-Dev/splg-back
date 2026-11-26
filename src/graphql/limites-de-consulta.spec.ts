import { buildSchema, parse, validate } from 'graphql';
import {
  CODIGO_CONSULTA_DEMASIADO_GRANDE,
  CODIGO_OPERACION_NO_PERMITIDA,
  limiteDeComplejidad,
  limiteDeProfundidad,
  soloConsultas,
} from './limites-de-consulta';

const esquema = buildSchema(`
  type Nodo { id: ID! hijo: Nodo }
  type Query { raiz: Nodo }
  type Mutation { cambiar: Boolean }
`);

const errores = (consulta: string, regla: Parameters<typeof validate>[2]) =>
  validate(esquema, parse(consulta), regla);

describe('limiteDeProfundidad', () => {
  const regla = [limiteDeProfundidad(3)];

  it('deja pasar hasta el máximo (el campo raíz cuenta 1)', () => {
    expect(errores('{ raiz { hijo { id } } }', regla)).toEqual([]);
  });

  it('rechaza un nivel más, con el texto y el code propios', () => {
    const [error] = errores('{ raiz { hijo { hijo { id } } } }', regla);
    expect(error.message).toBe('La consulta anida 4 niveles y el máximo es 3');
    expect(error.extensions).toEqual({
      code: CODIGO_CONSULTA_DEMASIADO_GRANDE,
      statusCode: 400,
    });
  });

  it('cuenta lo que anidan los fragmentos y los fragmentos en línea', () => {
    expect(
      errores(
        `{ raiz { ...F } }
         fragment F on Nodo { hijo { ... on Nodo { hijo { id } } } }`,
        regla,
      ),
    ).toHaveLength(1);
  });

  it('un fragmento que se incluye a sí mismo no lo cuelga (lo rechazan las reglas estándar)', () => {
    expect(() =>
      errores(`{ raiz { ...F } } fragment F on Nodo { id ...F }`, regla),
    ).not.toThrow();
  });

  it('un fragmento que no existe no cuenta', () => {
    expect(errores('{ raiz { ...NoExiste } }', regla)).toEqual([]);
  });

  it('la introspección no cuenta', () => {
    expect(
      errores(
        '{ __schema { types { fields { type { ofType { name } } } } } }',
        regla,
      ),
    ).toEqual([]);
  });
});

describe('limiteDeComplejidad', () => {
  it('cuenta 1 por campo y rechaza lo que pasa el máximo', () => {
    expect(errores('{ raiz { id } }', [limiteDeComplejidad(2)])).toEqual([]);
    const [error] = errores('{ raiz { id hijo { id } } }', [
      limiteDeComplejidad(2),
    ]);
    expect(error.message).toBe(
      'La consulta es demasiado compleja (4) y el máximo es 2: pedí menos informes o menos campos por consulta',
    );
    expect(error.extensions.code).toBe(CODIGO_CONSULTA_DEMASIADO_GRANDE);
  });
});

describe('soloConsultas', () => {
  it('una query pasa', () => {
    expect(errores('query { raiz { id } }', [soloConsultas])).toEqual([]);
  });

  it('una mutation se rechaza aunque el esquema la tenga', () => {
    const [error] = errores('mutation { cambiar }', [soloConsultas]);
    expect(error.message).toBe(
      'La API GraphQL es de sólo lectura: sólo acepta consultas (query)',
    );
    expect(error.extensions.code).toBe(CODIGO_OPERACION_NO_PERMITIDA);
  });
});
