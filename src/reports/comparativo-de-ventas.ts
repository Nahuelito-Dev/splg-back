import { periodoAnterior } from './domain/totales-de-ventas';
import type {
  ComparativoDeVentasDto,
  ResumenDeVentasDto,
} from './dto/report-v2.dto';
import { rangoDelInforme } from './rango-del-informe';

/** El resumen de un rango `[startDate, endDate)` (lo calcula `ReportsService`). */
export type ResumenDelRango = (
  startDate: Date,
  endDate: Date,
) => Promise<ResumenDeVentasDto>;

/**
 * Ventas, pedidos y ticket del rango pedido y del período inmediato anterior
 * de la misma cantidad de días (con `compare` en `false`, sólo el actual). Lo
 * comparten `GET /v2/reports/sales-summary` y la consulta `salesSummary` de
 * GraphQL: mismo rango, mismas validaciones (400 con fecha inválida o `from`
 * posterior a `to`) y misma respuesta.
 */
export async function comparativoDeVentas(
  from: string | undefined,
  to: string | undefined,
  compare: boolean | undefined,
  resumen: ResumenDelRango,
): Promise<ComparativoDeVentasDto> {
  const actual = rangoDelInforme(from, to);
  const current = await resumen(actual.startDate, actual.endDate);
  const currentRange = { from: actual.from, to: actual.to };
  if (compare === false) {
    return { current, previous: null, currentRange, previousRange: null };
  }
  const previo = periodoAnterior(actual.from, actual.to);
  const anterior = rangoDelInforme(previo.desde, previo.hasta);
  return {
    current,
    previous: await resumen(anterior.startDate, anterior.endDate),
    currentRange,
    previousRange: { from: anterior.from, to: anterior.to },
  };
}
