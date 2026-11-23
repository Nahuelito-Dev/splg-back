import { CorreccionDeVencimiento } from './autocalibracion';

const MS_POR_DIA = 86_400_000;

export interface EntradaDeProyeccion {
  dueAt: Date | null;
  dueKm: number | null;
  /** Kilometraje actual del vehículo. */
  odometerKm: number | null;
  /** Consumo diario estimado; `null` si no se pudo estimar. */
  kmPorDia: number | null;
  hoy: Date;
  /** Corrección por el desvío histórico del vehículo; se suma a la fecha por kilometraje. */
  correccion?: CorreccionDeVencimiento | null;
}

export interface ProyeccionDeVencimiento {
  /** El primero de los dos vencimientos (fecha fija y kilometraje); `null` si no hay forma de proyectarlo. */
  fecha: Date | null;
  /** Fecha en que el vehículo llega al kilometraje de la tarea. */
  porKilometraje: Date | null;
  /** La fecha por kilometraje antes de la corrección; es la que se mide contra lo real. */
  porKilometrajeSinCorregir: Date | null;
  /** La corrección que se aplicó a `porKilometraje`; `null` si no hubo. */
  correccion: CorreccionDeVencimiento | null;
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
  correccion = null,
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

  const sinCorregir = porKilometraje;
  let aplicada: CorreccionDeVencimiento | null = null;
  // Sólo se corrige una fecha estimada: un kilometraje ya alcanzado vence hoy.
  if (
    correccion &&
    correccion.correctionDays !== 0 &&
    porKilometraje !== null &&
    kmFaltantes !== null &&
    kmFaltantes > 0
  ) {
    const corrida =
      porKilometraje.getTime() + correccion.correctionDays * MS_POR_DIA;
    porKilometraje = new Date(Math.max(hoy.getTime(), corrida));
    // Lo que de verdad se movió (la fecha no pasa de hoy hacia atrás), y nada si
    // manda la fecha fija: no se informa una corrección que no cambió el vencimiento.
    const efectiva = Math.round(
      (porKilometraje.getTime() - (sinCorregir as Date).getTime()) / MS_POR_DIA,
    );
    const mandaLaFechaFija =
      dueAt !== null && dueAt.getTime() <= porKilometraje.getTime();
    if (efectiva !== 0 && !mandaLaFechaFija) {
      aplicada = { ...correccion, correctionDays: efectiva };
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
    porKilometrajeSinCorregir: sinCorregir,
    correccion: aplicada,
    kmFaltantes,
    enObservacion: dueAt === null && dueKm !== null && porKilometraje === null,
  };
}
