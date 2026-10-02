import { MaintenanceCriticality } from '../entities/maintenance-plan.entity';
import { ExpirationStatus } from './expiration-status';

/** Lo mínimo que hace falta de una tarea abierta para decidir si inhabilita. */
export interface HabilitacionRelevante {
  expirationStatus: ExpirationStatus | null;
  criticality: MaintenanceCriticality;
}

/**
 * CU-136/137/138: un vehículo o un chofer queda INHABILITADO cuando tiene al
 * menos una habilitación bloqueante (seguro, VTV, licencia) vencida. Una
 * tarea "por vencer" todavía no bloquea; una no bloqueante (service) nunca
 * bloquea, esté vencida o no.
 *
 * Función de dominio pura, sin acceso a datos: el caller (`FleetTaskService`)
 * arma `HabilitacionRelevante[]` con las tareas abiertas (no `done` ni
 * `cancelled`) del vehículo/chofer y sus planes.
 *
 * La usan las fachadas de sólo lectura (`/cars/:id/documents`,
 * `/delivery/:id/documents`) y, desde esta tarea, el despacho (automático y
 * manual) de `order`, vía `FleetTaskService`: un chofer inhabilitado no
 * recibe ofertas ni se le puede asignar un pedido a mano.
 */
export function estaInhabilitado(tareas: HabilitacionRelevante[]): boolean {
  return tareasQueInhabilitan(tareas).length > 0;
}

/**
 * Las tareas de `tareas` que efectivamente inhabilitan (bloqueante + vencida),
 * preservando el resto de sus campos: `estaInhabilitado` es este mismo cálculo
 * colapsado a booleano. Genérica para que el caller pueda pasar la tarea
 * completa (para armar un mensaje de error) y no sólo `HabilitacionRelevante`.
 */
export function tareasQueInhabilitan<T extends HabilitacionRelevante>(
  tareas: T[],
): T[] {
  return tareas.filter(
    (t) =>
      t.criticality === MaintenanceCriticality.BLOCKING &&
      t.expirationStatus === ExpirationStatus.EXPIRED,
  );
}

/**
 * Normaliza una fecha a la medianoche UTC de su fecha calendario. `dueAt`
 * guarda "la fecha calendario tal como la cargó el administrador" (ver
 * `expiration-status.ts`): si llega un ISO con hora (un datepicker que manda
 * la hora local, o un cliente que no limpia el componente de hora), una hora
 * distinta de cero correría el vencimiento a otro día calendario para
 * `formatearFechaUtc`/`finDeVigenciaEnArgentina` sin que nadie lo haya
 * pedido. Se aplica al recibir el dato (alta y edición de la tarea), no al
 * leerlo: todo lo que ya lee `dueAt` asume que viene normalizado.
 */
export function normalizarFechaCalendario(fecha: Date): Date {
  return new Date(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()),
  );
}

/** `dd/mm/aaaa` a partir de los componentes UTC de la fecha (determinista, sin importar la zona horaria del server). */
export function formatearFechaUtc(fecha: Date): string {
  const dia = String(fecha.getUTCDate()).padStart(2, '0');
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  const anio = fecha.getUTCFullYear();
  return `${dia}/${mes}/${anio}`;
}

/**
 * "Licencia de conducir: venció el 01/01/2020", para el 400 del gate de
 * asignación (de chofer o de vehículo). Sin adjetivo con género
 * ("vencido"/"vencida"): el nombre del plan no tiene género fijo (lo carga
 * el administrador). Compartida entre `FleetDispatchLockService` (chofer) y
 * `FleetTaskService` (vehículo): la regla de negocio es una sola.
 */
export function describirVencimiento(
  planName: string,
  dueAt: Date | null,
): string {
  if (!dueAt) {
    return `${planName}: sin fecha registrada`;
  }
  return `${planName}: venció el ${formatearFechaUtc(dueAt)}`;
}
