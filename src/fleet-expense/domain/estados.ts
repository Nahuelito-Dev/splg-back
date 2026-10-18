import { TrafficFineStatus } from '../entities/traffic-fine.entity';
import { VehicleAccidentStatus } from '../entities/vehicle-accident.entity';
import { TireEventType } from '../entities/tire-event.entity';
import { TireStatus } from '../entities/tire.entity';

/** Una multa pagada o anulada no vuelve atrás: sólo la pendiente y la apelada se tocan. */
export function multaAbierta(status: TrafficFineStatus): boolean {
  return (
    status === TrafficFineStatus.PENDING ||
    status === TrafficFineStatus.APPEALED
  );
}

/** El ciclo del siniestro, en orden. El cierre tiene su propia operación (CU-202). */
const CICLO_DEL_SINIESTRO: readonly VehicleAccidentStatus[] = [
  VehicleAccidentStatus.REPORTED,
  VehicleAccidentStatus.UNDER_REVIEW,
  VehicleAccidentStatus.REPAIRING,
];

/**
 * ¿Se puede pasar de `actual` a `nuevo` modificando el siniestro? Sólo al
 * estado siguiente del ciclo (o quedarse donde está); nunca saltear, volver
 * atrás ni cerrar por acá.
 */
export function transicionDeSiniestroValida(
  actual: VehicleAccidentStatus,
  nuevo: VehicleAccidentStatus,
): boolean {
  if (actual === nuevo) return actual !== VehicleAccidentStatus.CLOSED;
  const i = CICLO_DEL_SINIESTRO.indexOf(actual);
  return i >= 0 && CICLO_DEL_SINIESTRO[i + 1] === nuevo;
}

export interface EstadoDeNeumatico {
  status: TireStatus;
  carId: string | null;
  position: string | null;
}

/**
 * Qué movimientos admite cada estado: se monta uno en depósito, se desmonta o
 * rota uno montado, se recapa uno en depósito y se da de baja cualquiera que
 * no esté ya dado de baja (la baja es definitiva).
 */
export function movimientoValidoParaElEstado(
  tipo: TireEventType,
  estado: TireStatus,
): boolean {
  switch (tipo) {
    case TireEventType.MOUNT:
    case TireEventType.RETREAD:
      return estado === TireStatus.IN_STOCK;
    case TireEventType.UNMOUNT:
    case TireEventType.ROTATE:
      return estado === TireStatus.MOUNTED;
    case TireEventType.RETIRE:
      return estado !== TireStatus.RETIRED;
  }
}
