import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import {
  ESQUEMAS,
  ValoresDeProceso,
  valoresDesde,
} from '../../distributor/process-config';
import { cierreDeLaPlanificacion } from './route-sheet-rules';

/**
 * La planificación automática de una distribuidora: un solo criterio para la
 * propuesta automática (`RoutePlanService.paraProponer`) y para la retención
 * de los programados frente al despacho (`RoutePlanningHoldService`). Si los
 * dos no miran lo mismo, la retención guarda pedidos que nadie va a proponer.
 */
export interface DistribuidoraParaPlanificar {
  /** `distributor.status` (`active` | `suspended`). */
  status: string;
  deletedAt: Date | string | null;
  /** `module_config.params` de `route_planning`, o `null` si no guardó nada. */
  params: Record<string, unknown> | null;
}

/**
 * Los parámetros vigentes de la hoja si la distribuidora planifica sola:
 * activa, no dada de baja, con `enabled` y `autoPropose` efectivos en 1 (lo
 * guardado o el valor por omisión del esquema). `null` si no.
 */
export function planificacionAutomatica(
  d: DistribuidoraParaPlanificar,
): ValoresDeProceso | null {
  if (d.deletedAt !== null || d.status !== 'active') return null;
  const v = valoresDesde(
    ESQUEMAS[ConfigurableProcess.ROUTE_PLANNING],
    d.params,
  );
  return v.enabled === 1 && v.autoPropose === 1 ? v : null;
}

/** Lo que hace falta saber de un pedido para decidir si la planificación lo retiene. */
export interface PedidoParaRetener {
  /** `YYYY-MM-DD` o `null` si no es programado. */
  scheduledDate: string | null;
  deliveryMode: string;
  createdAt: Date;
  distribuidora: DistribuidoraParaPlanificar;
  /** La planificación de su día, si existe. */
  plan: { status: string; cutoffAt: Date } | null;
}

/**
 * Un programado estándar se retiene del despacho automático mientras la
 * propuesta del sistema lo vaya a tomar: la distribuidora planifica sola, su
 * día es posterior a hoy, se creó antes del cierre de su día y ese día no se
 * cerró. Con o sin franja. No es para siempre: el día del reparto
 * (`scheduledDate` = hoy) o con el día cerrado deja de retenerse y vuelve al
 * despacho común.
 */
export function retenidoPorLaPlanificacion(
  p: PedidoParaRetener,
  hoy: string,
): boolean {
  if (p.scheduledDate === null || p.deliveryMode !== 'standard') return false;
  if (p.scheduledDate <= hoy) return false;
  const v = planificacionAutomatica(p.distribuidora);
  if (!v) return false;
  const cierre = cierreDeLaPlanificacion(
    p.scheduledDate,
    v.cutoffHour,
    v.cutoffMinute,
  );
  if (p.createdAt >= cierre) return false;
  if (p.plan && (p.plan.status === 'closed' || p.createdAt >= p.plan.cutoffAt))
    return false;
  return true;
}
