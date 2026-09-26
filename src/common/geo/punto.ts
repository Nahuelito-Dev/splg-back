import { BadRequestException } from '@nestjs/common';
import type { Point } from 'typeorm';

/**
 * Las coordenadas se guardan como punto PostGIS (geometry Point, SRID 4326,
 * igual que las zonas de cobertura) y viajan por la API como el texto
 * "latitud,longitud" de siempre. Antes se guardaba ese texto: un valor no
 * atómico (fuera de 1FN) que la base no podía validar ni consultar por
 * cercanía.
 */

/** "lat,lng" → punto GeoJSON. GeoJSON va al revés: [longitud, latitud]. */
export function puntoDesdeLatLng(texto: string): Point {
  const [lat, lng] = texto.split(',').map((v) => Number(v.trim()));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    throw new BadRequestException(
      'Las coordenadas deben ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
    );
  }
  return { type: 'Point', coordinates: [lng, lat] };
}

/** Punto GeoJSON → "lat,lng", o null si no hay punto. */
export function latLngDesdePunto(
  punto: Point | null | undefined,
): string | null {
  if (!punto) return null;
  const [lng, lat] = punto.coordinates;
  return `${lat},${lng}`;
}

/** Latitud y longitud sueltas (como las manda la dirección) → punto. */
export function puntoDesdeCoordenadas(
  latitud: string | number,
  longitud: string | number,
): Point {
  return puntoDesdeLatLng(`${latitud},${longitud}`);
}

/** Punto → latitud y longitud por separado, o null si no hay punto. */
export function coordenadasDePunto(
  punto: Point | null | undefined,
): { lat: number; lng: number } | null {
  if (!punto) return null;
  const [lng, lat] = punto.coordinates;
  return { lat, lng };
}
