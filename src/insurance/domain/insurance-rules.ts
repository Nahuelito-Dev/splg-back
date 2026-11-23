import { sumarDias } from '../../common/utils/dias-argentina';
import {
  InstallmentApprovalStatus,
  InstallmentStatus,
  PolicyStatus,
} from './insurance.enums';

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

/**
 * El aviso de los 5 días pide la aprobación a la cuota pendiente que todavía no la
 * pidió y que vence entre hoy y dentro de `dias` días. Una ya vencida no entra
 * (no se arma una ola de pedidos de golpe): igual pide su aprobación cuando se la quiere pagar.
 */
export function debePedirAprobacion(
  cuota: {
    status: InstallmentStatus;
    approvalStatus: InstallmentApprovalStatus;
    dueDate: string;
  },
  hoy: string,
  dias: number,
): boolean {
  return (
    cuota.status === InstallmentStatus.PENDING &&
    cuota.approvalStatus === InstallmentApprovalStatus.NONE &&
    cuota.dueDate >= hoy &&
    cuota.dueDate <= sumarDias(hoy, dias)
  );
}

/** Se aprueba el pago de una cuota pendiente que todavía no está aprobada (haya o no pedido el aviso). */
export function puedeAprobarse(cuota: {
  status: InstallmentStatus;
  approvalStatus: InstallmentApprovalStatus;
}): boolean {
  return (
    cuota.status === InstallmentStatus.PENDING &&
    cuota.approvalStatus !== InstallmentApprovalStatus.APPROVED
  );
}

/** Todo pago requiere la aprobación del admin: sin ella (pedida o no) no se registra. */
export function pagoBloqueadoPorAprobacion(cuota: {
  approvalStatus: InstallmentApprovalStatus;
}): boolean {
  return cuota.approvalStatus !== InstallmentApprovalStatus.APPROVED;
}

/** El importe aprobado es el de la cuota: no se paga más que eso sin volver a aprobar. */
export function superaElImporteAprobado(
  cuota: { amount: number },
  importe: number,
): boolean {
  return importe > cuota.amount;
}
