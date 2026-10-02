import { Order } from '../entities/order.entity';
import { ReservationNotActivableError } from './errors/reservation-not-activable.error';

/**
 * Condiciones para activar una reserva (RESERVED → PENDING): las MISMAS que
 * exige el cron (`ReservationService.activateDueReservations`) — seña paga y
 * día agendado cumplido. Se valida también en la activación MANUAL
 * (`PATCH /orders/:id/status` con `status: pending` sobre una reserva) para
 * que no exista un segundo camino que se salte la política de reservas.
 */
export function assertReservaActivable(order: Order): void {
  if (!order.depositPaid) {
    throw new ReservationNotActivableError(
      'No se puede activar la reserva: la seña todavía no está paga',
    );
  }

  const hoy = new Date().toISOString().slice(0, 10);
  if (!order.scheduledDate || order.scheduledDate > hoy) {
    throw new ReservationNotActivableError(
      'No se puede activar la reserva antes de la fecha agendada',
    );
  }
}
