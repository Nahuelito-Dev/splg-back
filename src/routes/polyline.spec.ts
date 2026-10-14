import { decodificarPolilinea } from './polyline';

describe('decodificarPolilinea', () => {
  it('decodifica el ejemplo de la documentación de Google', () => {
    expect(decodificarPolilinea('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  it('una cadena vacía no tiene puntos', () => {
    expect(decodificarPolilinea('')).toEqual([]);
  });

  it('una polilínea truncada es un error, no un punto inventado', () => {
    expect(() => decodificarPolilinea('_p~iF~ps|U_ulL')).toThrow(
      'Polilínea truncada',
    );
  });
});
