import { sumarDias } from '../../common/utils/dias-argentina';
import { InstallmentStatus, PolicyStatus } from './insurance.enums';

/** Estado de la póliza hoy (`YYYY-MM-DD`): `[validFrom, validTo)`. */
export function estadoDeLaPoliza(
  poliza: { validFrom: string; validTo: string; cancelledAt: Date | null },
  hoy: string,
): PolicyStatus {
  if (poliza.cancelledAt) return PolicyStatus.CANCELLED;
  if (hoy < poliza.validFrom) return PolicyStatus.UPCOMING;
  if (hoy >= poliza.validTo) return PolicyStatus.EXPIRED;
  return PolicyStatus.ACTIVE;
}

/** Una cuota pendiente cuyo vencimiento cae dentro de `dias` días o antes (incluye las ya vencidas). */
export function vencePronto(
  cuota: { status: InstallmentStatus; dueDate: string },
  hoy: string,
  dias: number,
): boolean {
  return (
    cuota.status === InstallmentStatus.PENDING &&
    cuota.dueDate <= sumarDias(hoy, dias)
  );
}

/** Una cuota pendiente a la que se le pasó la gracia: el pago ya no se juzga en término. */
export function conGraciaVencida(
  cuota: { status: InstallmentStatus; graceUntil: string },
  hoy: string,
): boolean {
  return cuota.status === InstallmentStatus.PENDING && cuota.graceUntil < hoy;
}

/** ¿La póliza (no cancelada) vence dentro de `dias` días o antes, sin haber vencido ya? */
export function polizaPorVencer(
  poliza: { validTo: string; cancelledAt: Date | null },
  hoy: string,
  dias: number,
): boolean {
  return (
    poliza.cancelledAt === null &&
    poliza.validTo >= hoy &&
    poliza.validTo <= sumarDias(hoy, dias)
  );
}
