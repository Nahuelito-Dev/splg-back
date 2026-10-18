import {
  MaintenanceCriticality,
  MaintenanceDocumentKind,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../entities/maintenance-plan.entity';
import { JobPositionCategory } from '../../employee/entities/job-position.entity';

/**
 * Los 7 planes con los que arranca cualquier distribuidora nueva (CU-136 a
 * CU-138 + service, y la documentación del personal de CU-183 a CU-185). Cada distribuidora puede después crear los suyos propios
 * o desactivar éstos; esto es sólo el punto de partida.
 *
 * MISMOS valores que las migraciones `SembrarPlanesBaseDeFlota` y
 * `DocumentacionAsistenciaYLicenciasDelPersonal` usan para las distribuidoras
 * que ya existían: si se cambia uno, se cambia en los dos lados (una
 * migración no puede importar TS).
 */
export interface BasePlanDefinition {
  name: string;
  subject: MaintenanceSubject;
  trigger: MaintenanceTrigger;
  leadTimeDays: number;
  criticality: MaintenanceCriticality;
  intervalKm: number | null;
  intervalMonths: number | null;
  documentKind: MaintenanceDocumentKind;
  /** `null` = aplica a todas las categorías de puesto. */
  appliesToCategories: JobPositionCategory[] | null;
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
    documentKind: MaintenanceDocumentKind.INSURANCE,
    appliesToCategories: null,
  },
  {
    name: 'VTV',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
    documentKind: MaintenanceDocumentKind.VTV,
    appliesToCategories: null,
  },
  {
    name: 'Licencia de conducir',
    subject: MaintenanceSubject.DRIVER,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
    documentKind: MaintenanceDocumentKind.DRIVER_LICENSE,
    appliesToCategories: [JobPositionCategory.DRIVER],
  },
  {
    name: 'Service / cambio de aceite',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_KM,
    leadTimeDays: 15,
    criticality: MaintenanceCriticality.NON_BLOCKING,
    intervalKm: 10000,
    intervalMonths: null,
    documentKind: MaintenanceDocumentKind.SERVICE,
    appliesToCategories: null,
  },
  {
    name: 'Curso de transporte de mercancías peligrosas (GLP)',
    subject: MaintenanceSubject.EMPLOYEE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 60,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
    documentKind: MaintenanceDocumentKind.HAZMAT_DRIVER_COURSE,
    appliesToCategories: [JobPositionCategory.DRIVER],
  },
  {
    name: 'Examen psicofísico',
    subject: MaintenanceSubject.EMPLOYEE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    intervalKm: null,
    intervalMonths: null,
    documentKind: MaintenanceDocumentKind.PSYCHOPHYSICAL,
    appliesToCategories: [JobPositionCategory.DRIVER],
  },
  {
    name: 'Alta en ART',
    subject: MaintenanceSubject.EMPLOYEE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.NON_BLOCKING,
    intervalKm: null,
    intervalMonths: null,
    documentKind: MaintenanceDocumentKind.ART_COVERAGE,
    appliesToCategories: null,
  },
] as const;
