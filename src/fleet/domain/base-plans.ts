import {
  MaintenanceCriticality,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../entities/maintenance-plan.entity';

/**
 * Los 4 planes con los que arranca cualquier distribuidora nueva (CU-136 a
 * CU-138 + service). Cada distribuidora puede después crear los suyos propios
 * o desactivar éstos; esto es sólo el punto de partida.
 *
 * MISMOS valores que la migración `SembrarPlanesBaseDeFlota` usa para las
 * distribuidoras que ya existían: si se cambia uno, se cambia en los dos
 * lados (la migración no puede importar TS).
 */
export interface BasePlanDefinition {
  name: string;
  subject: MaintenanceSubject;
  trigger: MaintenanceTrigger;
  leadTimeDays: number;
  criticality: MaintenanceCriticality;
  intervalKm: number | null;
  intervalMonths: number | null;
}

export const BASE_PLAN_DEFINITIONS: readonly BasePlanDefinition[] = [
  {
    name: 'Seguro del vehículo',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
  },
  {
    name: 'VTV',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
  },
  {
    name: 'Licencia de conducir',
    subject: MaintenanceSubject.DRIVER,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
  },
  {
    name: 'Service / cambio de aceite',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_KM,
    leadTimeDays: 15,
    criticality: MaintenanceCriticality.NON_BLOCKING,
    intervalKm: 10000,
    intervalMonths: null,
  },
] as const;
