import { EmployeeStatus } from '../entities/employee.entity';

export type RechazoDeEgreso = 'YA_EGRESADO' | 'FECHA_ANTERIOR_AL_INGRESO';
export type RechazoDeReingreso = 'NO_EGRESADO' | 'FECHA_ANTERIOR_AL_EGRESO';

interface EstadoLaboral {
  status: EmployeeStatus;
  hireDate: string;
  terminationDate: string | null;
}

/**
 * Transiciones del legajo: `active` -> `terminated` (egreso) y de vuelta
 * (reingreso). Las fechas son días calendario `YYYY-MM-DD`, que se comparan
 * como texto. Devuelven el motivo del rechazo o `null` si se puede.
 */
export function validarEgreso(
  empleado: EstadoLaboral,
  fechaDeEgreso: string,
): RechazoDeEgreso | null {
  if (empleado.status !== EmployeeStatus.ACTIVE) return 'YA_EGRESADO';
  if (fechaDeEgreso < empleado.hireDate) return 'FECHA_ANTERIOR_AL_INGRESO';
  return null;
}

export function validarReingreso(
  empleado: EstadoLaboral,
  fechaDeIngreso: string,
): RechazoDeReingreso | null {
  if (empleado.status !== EmployeeStatus.TERMINATED) return 'NO_EGRESADO';
  if (empleado.terminationDate && fechaDeIngreso < empleado.terminationDate) {
    return 'FECHA_ANTERIOR_AL_EGRESO';
  }
  return null;
}

/**
 * La fecha de nacimiento (si se conoce) es anterior a la de ingreso. Fechas
 * `YYYY-MM-DD`, que se comparan como texto.
 */
export function nacimientoAnteriorAlIngreso(
  nacimiento: string | null | undefined,
  ingreso: string,
): boolean {
  return !nacimiento || nacimiento < ingreso;
}
