import { instanteDelPago } from './payment-date';

describe('instanteDelPago', () => {
  it('una fecha sin hora es el primer instante de ese día en hora argentina (03:00 UTC), no medianoche UTC', () => {
    expect(instanteDelPago('2026-10-20')).toEqual(
      new Date('2026-10-20T03:00:00.000Z'),
    );
  });

  it('con hora y zona es ese instante', () => {
    expect(instanteDelPago('2026-10-20T14:30:00-03:00')).toEqual(
      new Date('2026-10-20T17:30:00.000Z'),
    );
  });
});
