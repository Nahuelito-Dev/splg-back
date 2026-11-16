import { BadRequestException } from '@nestjs/common';
import { latLngDesdePunto, puntoDesdeLatLng } from './punto';

describe('coordenadas "lat,lng" ↔ punto', () => {
  it('guarda [longitud, latitud], como pide GeoJSON', () => {
    expect(puntoDesdeLatLng('-27.3671,-55.8961')).toEqual({
      type: 'Point',
      coordinates: [-55.8961, -27.3671],
    });
  });

  it('vuelve al mismo texto', () => {
    expect(latLngDesdePunto(puntoDesdeLatLng('-27.375155,-55.896341'))).toBe(
      '-27.375155,-55.896341',
    );
    expect(latLngDesdePunto(puntoDesdeLatLng(' -27.4 , -55.9 '))).toBe(
      '-27.4,-55.9',
    );
  });

  it('sin punto es null', () => {
    expect(latLngDesdePunto(null)).toBeNull();
  });

  it('rechaza lo que no son coordenadas', () => {
    for (const malo of ['12345', 'a,b', '-95,10', '10,200', '']) {
      expect(() => puntoDesdeLatLng(malo)).toThrow(BadRequestException);
    }
  });
});
