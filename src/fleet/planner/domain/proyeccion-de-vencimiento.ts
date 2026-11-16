const MS_POR_DIA = 86_400_000;

export interface EntradaDeProyeccion {
  dueAt: Date | null;
  dueKm: number | null;
  /** Kilometraje actual del vehículo. */
  odometerKm: number | null;
  /** Consumo diario estimado; `null` si no se pudo estimar. */
  kmPorDia: number | null;
  hoy: Date;
}

export interface ProyeccionDeVencimiento {
  /** El primero de los dos vencimientos (fecha fija y kilometraje); `null` si no hay forma de proyectarlo. */
  fecha: Date | null;
  /** Fecha en que el vehículo llega al kilometraje de la tarea. */
  porKilometraje: Date | null;
  /** Kilómetros que faltan; negativo si ya se pasó. */
  kmFaltantes: number | null;
  /**
   * La tarea es por kilometraje pero no hay consumo con qué proyectarla y no
   * tiene fecha: queda en observación.
   */
  enObservacion: boolean;
}

/**
 * Proyecta cuándo vence una tarea: la fecha fija es el vencimiento tal cual; la
 * de kilometraje, los kilómetros que faltan sobre el consumo diario estimado.
 * Si tiene las dos, vence la primera que llegue.
 */
export function proyectarVencimiento({
  dueAt,
  dueKm,
  odometerKm,
  kmPorDia,
  hoy,
}: EntradaDeProyeccion): ProyeccionDeVencimiento {
  const tieneKm = dueKm !== null && odometerKm !== null;
  const kmFaltantes = tieneKm ? dueKm - odometerKm : null;

  let porKilometraje: Date | null = null;
  if (kmFaltantes !== null) {
    if (kmFaltantes <= 0) {
      porKilometraje = hoy;
    } else if (kmPorDia !== null && kmPorDia > 0) {
      porKilometraje = new Date(
        hoy.getTime() + Math.ceil(kmFaltantes / kmPorDia) * MS_POR_DIA,
      );
    }
  }

  const candidatas = [dueAt, porKilometraje].filter(
    (d): d is Date => d !== null,
  );
  const fecha =
    candidatas.length === 0
      ? null
      : new Date(Math.min(...candidatas.map((d) => d.getTime())));
  return {
    fecha,
    porKilometraje,
    kmFaltantes,
    enObservacion: dueAt === null && dueKm !== null && porKilometraje === null,
  };
}
