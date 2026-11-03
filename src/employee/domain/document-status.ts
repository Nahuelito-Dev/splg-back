/**
 * Estado de la documentación de un empleado en el listado (CU-180): resume sus
 * documentos abiertos con los mismos criterios de vencimiento de CU-187
 * (`calcularEstadoDeVencimiento`) y los planes activos que le aplican.
 */
export enum EmployeeDocumentStatus {
  /** Todo cargado y fuera de la ventana de aviso. */
  UP_TO_DATE = 'up_to_date',
  /** Algún documento entró en la ventana de anticipación de su plan. */
  DUE_SOON = 'due_soon',
  /** Algún documento ya venció. */
  EXPIRED = 'expired',
  /** Le falta cargar un documento de un plan activo que le aplica. */
  MISSING = 'missing',
}

/** Cómo se nombra cada estado en los archivos exportados y en los textos. */
export const ETIQUETA_DE_DOCUMENTACION: Record<EmployeeDocumentStatus, string> =
  {
    [EmployeeDocumentStatus.UP_TO_DATE]: 'Al día',
    [EmployeeDocumentStatus.DUE_SOON]: 'Por vencer',
    [EmployeeDocumentStatus.EXPIRED]: 'Vencida',
    [EmployeeDocumentStatus.MISSING]: 'Falta cargar',
  };
