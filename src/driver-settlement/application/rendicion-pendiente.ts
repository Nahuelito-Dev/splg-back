import { EntityManager } from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { pesos } from '../../pdf/pdf-formato';
import { ESTADOS_SIN_CERRAR } from '../domain/driver-settlement.enums';
import { pedidosSinRendir, sumaACobrar } from './settlement-orders';

const ESTADO_DE_LA_RENDICION: Record<string, string> = {
  open: 'abierta',
  submitted: 'presentada',
};

/** Qué le falta rendir a un chofer: una rendición sin cerrar o efectivo que ninguna rendición tomó. */
export type PendienteDeRendir =
  | { tipo: 'rendicion'; numero: number; estado: string; dia: string }
  | { tipo: 'efectivo'; pedidos: number; monto: string };

/**
 * Lo que le falta rendir a un chofer, o `null` si está al día: una rendición
 * sin cerrar (`ESTADOS_SIN_CERRAR`, de cualquier día) o, si no tiene ninguna,
 * efectivo entregado que ninguna rendición tomó (`pedidosSinRendir`, la regla
 * de la rendición del día).
 */
export async function pendienteDeRendir(
  manager: EntityManager,
  distributorId: string,
  deliveryId: string,
): Promise<PendienteDeRendir | null> {
  const [sinCerrar]: Array<{
    number: number;
    status: string;
    business_date: string;
  }> = await manager.query(
    `SELECT "number", "status"::text AS status, "business_date"::text AS business_date
     FROM "driver_settlement"
     WHERE "distributor_id" = $1 AND "delivery_id" = $2 AND "status"::text = ANY($3::text[])
     ORDER BY "business_date", "number" LIMIT 1`,
    [distributorId, deliveryId, [...ESTADOS_SIN_CERRAR]],
  );
  if (sinCerrar) {
    return {
      tipo: 'rendicion',
      numero: sinCerrar.number,
      estado: ESTADO_DE_LA_RENDICION[sinCerrar.status] ?? sinCerrar.status,
      dia: sinCerrar.business_date.split('-').reverse().join('/'),
    };
  }
  const pedidos = await pedidosSinRendir(manager, {
    distributorId,
    deliveryId,
    businessDate: diaArgentino(),
  });
  if (pedidos.length > 0) {
    return {
      tipo: 'efectivo',
      pedidos: pedidos.length,
      monto: pesos(sumaACobrar(pedidos).toNumber()),
    };
  }
  return null;
}

/** El motivo del rechazo del egreso. */
export function mensajeDeRendicionPendiente(
  pendiente: PendienteDeRendir,
): string {
  const base = 'No se puede dar de baja al chofer mientras tenga';
  if (pendiente.tipo === 'rendicion') {
    return `${base} una rendición pendiente (rendición N° ${pendiente.numero}, ${pendiente.estado}, del ${pendiente.dia}): cerrala antes`;
  }
  return `${base} efectivo sin rendir (${pendiente.pedidos} pedido(s) en efectivo por ${pendiente.monto}): generá y aprobá su rendición antes`;
}
