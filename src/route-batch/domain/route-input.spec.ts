import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { assertValidCoordinates, assertValidStops } from './route-input';
import { matrixOf, stopAt, XY } from './route-fixtures';

const puntos: XY[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
];
const matriz = matrixOf(puntos);

describe('assertValidStops', () => {
  it('una hoja válida (y una vacía) pasa', () => {
    expect(() =>
      assertValidStops(
        [stopAt('a', 1, 0, 10), stopAt('b', 2, 0, 10)],
        matriz,
        0,
      ),
    ).not.toThrow();
    expect(() => assertValidStops([], matriz, 0)).not.toThrow();
  });

  it.each([
    ['un punto más allá de la matriz', 3],
    ['un punto negativo', -1],
    ['un punto que no es entero', 1.5],
    ['un punto NaN', NaN],
  ])('rechaza %s', (_nombre, point) => {
    expect(() =>
      assertValidStops([stopAt('a', point, 0, 10)], matriz, 0),
    ).toThrow(InvalidRouteInputError);
  });

  it('rechaza un punto que está en las filas de minutos pero no en las de kilómetros', () => {
    const corta = { minutes: matriz.minutes, km: matriz.km.slice(0, 2) };
    expect(() => assertValidStops([stopAt('a', 2, 0, 10)], corta, 0)).toThrow(
      InvalidRouteInputError,
    );
  });

  it.each([
    ['sin matriz de salida', 5],
    ['una salida negativa', -1],
    ['una salida que no es entera', 0.5],
  ])('rechaza %s', (_nombre, origen) => {
    expect(() => assertValidStops([], matriz, origen)).toThrow(
      InvalidRouteInputError,
    );
  });

  it('rechaza la franja invertida, la que tiene NaN o Infinity, y los ids repetidos', () => {
    expect(() => assertValidStops([stopAt('a', 1, 10, 5)], matriz, 0)).toThrow(
      /termina antes de empezar/,
    );
    expect(() =>
      assertValidStops(
        [{ ...stopAt('a', 1, 0, 10), windowEndMs: Infinity }],
        matriz,
        0,
      ),
    ).toThrow(/no es un número/);
    expect(() =>
      assertValidStops(
        [{ ...stopAt('a', 1, 0, 10), windowStartMs: NaN }],
        matriz,
        0,
      ),
    ).toThrow(/no es un número/);
    expect(() =>
      assertValidStops(
        [stopAt('a', 1, 0, 10), stopAt('a', 2, 0, 10)],
        matriz,
        0,
      ),
    ).toThrow(/repetido/);
  });

  it('una franja de un solo instante es válida', () => {
    expect(() =>
      assertValidStops([stopAt('a', 1, 5, 5)], matriz, 0),
    ).not.toThrow();
  });
});

describe('assertValidCoordinates', () => {
  it('sin punto de entrega (las dos nulas) no se valida nada', () => {
    expect(() => assertValidCoordinates('a', null, null)).not.toThrow();
  });

  it('coordenadas del Gran Posadas y del borde del mundo son válidas', () => {
    expect(() => assertValidCoordinates('a', -27.36, -55.9)).not.toThrow();
    expect(() => assertValidCoordinates('a', 90, 180)).not.toThrow();
    expect(() => assertValidCoordinates('a', -90, -180)).not.toThrow();
  });

  it.each([
    ['sólo la latitud nula', null, -55.9],
    ['sólo la longitud nula', -27.36, null],
    ['latitud mayor a 90', 90.01, 0],
    ['latitud menor a -90', -90.01, 0],
    ['longitud mayor a 180', 0, 180.01],
    ['longitud menor a -180', 0, -180.01],
    ['latitud NaN', NaN, 0],
    ['longitud Infinity', 0, Infinity],
  ])('rechaza %s', (_nombre, lat, lng) => {
    expect(() => assertValidCoordinates('ord-1', lat, lng)).toThrow(
      InvalidRouteInputError,
    );
  });
});
