import { codificarPolilinea, decodificarPolilinea } from './polyline';

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

describe('codificarPolilinea', () => {
  it('codifica el ejemplo de la documentación de Google', () => {
    expect(
      codificarPolilinea([
        { lat: 38.5, lng: -120.2 },
        { lat: 40.7, lng: -120.95 },
        { lat: 43.252, lng: -126.453 },
      ]),
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('es la inversa de decodificar (con negativos, ceros y precisión 5)', () => {
    const puntos = [
      { lat: -27.36712, lng: -55.89613 },
      { lat: -27.36712, lng: -55.89613 },
      { lat: 0, lng: 0 },
      { lat: -34.60372, lng: -58.38159 },
    ];
    expect(decodificarPolilinea(codificarPolilinea(puntos))).toEqual(puntos);
    expect(codificarPolilinea([])).toBe('');
  });
});
