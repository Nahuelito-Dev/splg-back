import { medirConfirmacion } from './delivery-confirmation';

const DOMICILIO = { lat: -27.3671, lng: -55.8961 };
/** ≈ 56 m al sur del domicilio. */
const CERCA = { lat: DOMICILIO.lat - 0.0005, lng: DOMICILIO.lng };
/** ≈ 2,2 km al sur del domicilio. */
const LEJOS = { lat: DOMICILIO.lat - 0.02, lng: DOMICILIO.lng };

describe('medirConfirmacion', () => {
  it('dentro del radio: mide la distancia y no marca', () => {
    const r = medirConfirmacion(CERCA, DOMICILIO, 100);
    expect(r.distanceM).toBeGreaterThan(50);
    expect(r.distanceM).toBeLessThan(60);
    expect(r.outOfRange).toBe(false);
  });

  it('fuera del radio: marca pero informa la distancia', () => {
    const r = medirConfirmacion(LEJOS, DOMICILIO, 100);
    expect(r.distanceM).toBeGreaterThan(2000);
    expect(r.outOfRange).toBe(true);
  });

  it('radio 0: el control está apagado y nunca marca', () => {
    expect(medirConfirmacion(LEJOS, DOMICILIO, 0).outOfRange).toBe(false);
  });

  it('sin domicilio con coordenadas no hay con qué medir', () => {
    expect(medirConfirmacion(CERCA, null, 100)).toEqual({
      distanceM: null,
      outOfRange: false,
    });
  });
});
