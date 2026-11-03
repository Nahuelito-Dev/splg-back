/**
 * Validación de lo que entra a los algoritmos de ruteo. Una franja invertida,
 * un punto fuera de la matriz, un id repetido o una coordenada que no es un
 * número darían resultados sin sentido (o un TypeError lejos de la causa): se
 * rechazan acá con un error de dominio que dice qué está mal.
 */
import { RouteStop } from './eta';
import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { TravelMatrix } from './travel-matrix';

const esNumero = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n);

function assertPoint(
  point: unknown,
  matrix: TravelMatrix,
  quien: string,
): void {
  if (
    !esNumero(point) ||
    !Number.isInteger(point) ||
    point < 0 ||
    point >= matrix.minutes.length ||
    point >= matrix.km.length
  ) {
    throw new InvalidRouteInputError(
      `${quien} apunta a un punto (${String(point)}) que no está en la matriz`,
    );
  }
}

export function assertValidStops(
  stops: readonly RouteStop[],
  matrix: TravelMatrix,
  originPoint: number,
): void {
  assertPoint(originPoint, matrix, 'la salida');
  const vistos = new Set<string>();
  for (const s of stops) {
    if (vistos.has(s.id)) {
      throw new InvalidRouteInputError(`el pedido ${s.id} está repetido`);
    }
    vistos.add(s.id);
    assertPoint(s.point, matrix, `el pedido ${s.id}`);
    if (!esNumero(s.windowStartMs) || !esNumero(s.windowEndMs)) {
      throw new InvalidRouteInputError(
        `la franja del pedido ${s.id} no es un número`,
      );
    }
    if (s.windowStartMs > s.windowEndMs) {
      throw new InvalidRouteInputError(
        `la franja del pedido ${s.id} termina antes de empezar`,
      );
    }
  }
}

export function assertValidCoordinates(
  id: string,
  lat: number | null,
  lng: number | null,
): void {
  if (lat === null && lng === null) return;
  if (
    !esNumero(lat) ||
    !esNumero(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    throw new InvalidRouteInputError(
      `las coordenadas del pedido ${id} no son válidas`,
    );
  }
}
