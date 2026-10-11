import { assertReservaActivable } from './reservation-activation';
import { Order } from '../entities/order.entity';

describe('assertReservaActivable — el día es el argentino', () => {
  // 22:30 del 10/10 en Argentina = 01:30 UTC del 11/10.
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-10-11T01:30:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  const reserva = (scheduledDate: string): Order =>
    ({ depositPaid: true, scheduledDate }) as unknown as Order;

  it('una reserva agendada para HOY argentino ya se puede activar', () => {
    expect(() => assertReservaActivable(reserva('2026-10-10'))).not.toThrow();
  });

  it('una reserva de mañana argentino todavía no', () => {
    expect(() => assertReservaActivable(reserva('2026-10-11'))).toThrow(
      'antes de la fecha agendada',
    );
  });

  it('sin seña paga no se activa', () => {
    expect(() =>
      assertReservaActivable({
        depositPaid: false,
        scheduledDate: '2026-10-10',
      } as unknown as Order),
    ).toThrow('seña');
  });
});
