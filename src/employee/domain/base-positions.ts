import { JobPositionCategory } from '../entities/job-position.entity';

/**
 * Los puestos con los que arranca toda distribuidora (CU-176). Cada una puede
 * después crear los suyos o desactivar estos.
 *
 * MISMOS valores que las migraciones `SembrarPuestosDeTrabajo` y
 * `BackfillDeEmpleados` usan para las distribuidoras que ya existían (una
 * migración no puede importar TS): si se cambia uno, se cambia en los dos lados.
 */
export interface BasePositionDefinition {
  name: string;
  category: JobPositionCategory;
}

export const BASE_POSITION_DEFINITIONS: readonly BasePositionDefinition[] = [
  { name: 'Chofer', category: JobPositionCategory.DRIVER },
  { name: 'Ayudante', category: JobPositionCategory.HELPER },
  { name: 'Depósito', category: JobPositionCategory.WAREHOUSE },
  { name: 'Administración', category: JobPositionCategory.ADMINISTRATION },
  { name: 'Vendedor', category: JobPositionCategory.SALES },
];
