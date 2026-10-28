/** Qué se puede cargar en forma masiva. Los clientes no: crean cuentas de Firebase. */
export enum ImportResource {
  GARRAFAS = 'garrafas',
  PRECIOS = 'precios',
  STOCK = 'stock',
  PROVEEDORES = 'proveedores',
}

export enum ImportJobStatus {
  /** Sin errores: se puede confirmar. */
  PENDING = 'pending',
  /** La vista previa tiene errores: no se confirma, se corrige el archivo y se vuelve a subir. */
  WITH_ERRORS = 'with_errors',
  CONFIRMED = 'confirmed',
}

export enum ImportFormat {
  XLSX = 'xlsx',
  CSV = 'csv',
}
