/**
 * La sesión de soporte con la que el administrador general hace la request
 * (`X-Support-Session`), ya validada por `AuthGuard`: activa, suya y en plazo.
 * Fija el tenant de la request; el `X-Distributor` no se lee.
 */
export interface SesionDeSoporteEnCurso {
  id: string;
  distributorId: string;
  /** `personal_data`, `files`, `exports` (lo aplica la etapa E2). */
  scope: string[];
  expiresAt: Date;
}
