import Decimal from 'decimal.js';
import {
  AgingBucket,
  CustomerAccountStatus,
  CustomerEntryType,
} from './customer-account.enums';
import { CuentaConflictoError } from './errors/customer-account.errors';

/** `+1` si el asiento suma a la deuda del cliente, `-1` si la baja. */
export function signoDelAsiento(tipo: CustomerEntryType): 1 | -1 {
  return tipo === CustomerEntryType.SALE_CHARGE ||
    tipo === CustomerEntryType.DEBIT_NOTE
    ? 1
    : -1;
}

/** Saldo de la cuenta después de aplicar un asiento (positivo: el cliente debe). */
export function saldoDespuesDelAsiento(
  saldo: Decimal.Value,
  tipo: CustomerEntryType,
  importe: Decimal.Value,
): Decimal {
  return new Decimal(saldo).plus(
    new Decimal(importe).times(signoDelAsiento(tipo)),
  );
}

/**
 * Crédito disponible: límite − deuda − pedidos a cuenta todavía no entregados
 * (su cargo aún no está en el saldo). Puede ser negativo si el cliente se pasó.
 */
export function creditoDisponible(
  limite: Decimal.Value,
  saldo: Decimal.Value,
  pedidosAbiertos: Decimal.Value,
): Decimal {
  return new Decimal(limite).minus(saldo).minus(pedidosAbiertos);
}

/** Fecha de vencimiento (YYYY-MM-DD) de un cargo: la entrega más el plazo. */
export function vencimientoDe(
  diaDeEntrega: string,
  plazoEnDias: number,
): string {
  const [a, m, d] = diaDeEntrega.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + plazoEnDias))
    .toISOString()
    .slice(0, 10);
}

/** Días entre dos `YYYY-MM-DD` (hasta − desde). */
export function diasEntre(desde: string, hasta: string): number {
  const f = (s: string): number => {
    const [a, m, d] = s.split('-').map(Number);
    return Date.UTC(a, m - 1, d);
  };
  return Math.round((f(hasta) - f(desde)) / 86_400_000);
}

/** El rango de antigüedad de un comprobante de hace `dias` días. */
export function rangoDeAntiguedad(dias: number): AgingBucket {
  if (dias <= 30) return AgingBucket.D0_30;
  if (dias <= 60) return AgingBucket.D31_60;
  if (dias <= 90) return AgingBucket.D61_90;
  return AgingBucket.D90_PLUS;
}

export interface AsientoParaImputar {
  entryId: string;
  /** Lo que todavía no se aplicó del asiento. */
  pendiente: Decimal;
}

export interface Imputacion {
  debitEntryId: string;
  creditEntryId: string;
  amount: Decimal;
}

/**
 * Imputación FIFO: los créditos (pagos, notas de crédito) saldan los cargos
 * pendientes del más viejo al más nuevo. Ambas listas vienen ordenadas por
 * antigüedad. Es pura: no toca la base.
 */
export function imputarFifo(
  cargos: AsientoParaImputar[],
  creditos: AsientoParaImputar[],
): Imputacion[] {
  const resultado: Imputacion[] = [];
  const debitos = cargos.map((c) => ({ ...c }));
  for (const credito of creditos) {
    let restante = credito.pendiente;
    for (const cargo of debitos) {
      if (restante.lte(0)) break;
      if (cargo.pendiente.lte(0)) continue;
      const aplicado = Decimal.min(restante, cargo.pendiente);
      resultado.push({
        debitEntryId: cargo.entryId,
        creditEntryId: credito.entryId,
        amount: aplicado,
      });
      cargo.pendiente = cargo.pendiente.minus(aplicado);
      restante = restante.minus(aplicado);
    }
  }
  return resultado;
}

/**
 * Máquina de estados de la cuenta corriente:
 *  - ACTIVE  ↔ BLOCKED (bloquear impide vender a cuenta; desbloquear la habilita);
 *  - ACTIVE | BLOCKED → CLOSED (cerrar exige saldo cero y sin pedidos abiertos);
 *  - CLOSED → ACTIVE (reabrir). Una cuenta cerrada no pasa directo a bloqueada.
 */
export const TRANSICIONES_DE_CUENTA: Readonly<
  Record<CustomerAccountStatus, readonly CustomerAccountStatus[]>
> = {
  [CustomerAccountStatus.ACTIVE]: [
    CustomerAccountStatus.BLOCKED,
    CustomerAccountStatus.CLOSED,
  ],
  [CustomerAccountStatus.BLOCKED]: [
    CustomerAccountStatus.ACTIVE,
    CustomerAccountStatus.CLOSED,
  ],
  [CustomerAccountStatus.CLOSED]: [CustomerAccountStatus.ACTIVE],
};

/** 409 si la cuenta no puede pasar de `desde` a `hacia`. Repetir el estado es un no-op. */
export function exigirTransicionDeCuenta(
  desde: CustomerAccountStatus,
  hacia: CustomerAccountStatus,
): void {
  if (desde === hacia) return;
  if (!TRANSICIONES_DE_CUENTA[desde].includes(hacia)) {
    throw new CuentaConflictoError(
      `Una cuenta ${desde === CustomerAccountStatus.CLOSED ? 'cerrada' : desde} no puede pasar a ${hacia}: ${
        desde === CustomerAccountStatus.CLOSED
          ? 'reabrila primero (estado active)'
          : 'transición no permitida'
      }`,
    );
  }
}
