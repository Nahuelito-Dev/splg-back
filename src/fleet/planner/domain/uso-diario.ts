import { diaArgentino, sumarDias } from '../../../common/utils/dias-argentina';

/** Una parada entregada, con dónde fue (WGS84) y cuándo. */
export interface ParadaEntregada {
  /** Instante de la entrega. */
  at: Date;
  lat: number;
  lng: number;
}

/** Lo que se estima de un vehículo en un día a partir de sus entregas. */
export interface UsoDelDia {
  day: string;
  km: number;
  orders: number;
  routeHours: number;
}

/** Una lectura del odómetro con su fecha (carga de combustible o cierre de una tarea). */
export interface LecturaDeOdometro {
  at: Date;
  km: number;
}

/**
 * Las calles no son una línea recta: la distancia entre dos paradas se
 * multiplica por este factor (urbano, 1,3 es lo habitual). Sólo corrige el
 * recorrido estimado; cuando hay odómetro, manda el odómetro.
 */
export const FACTOR_DE_RECORRIDO = 1.3;

const RADIO_TIERRA_KM = 6371.0088;
const rad = (g: number) => (g * Math.PI) / 180;

/** Distancia en km sobre la esfera entre dos puntos (haversine). */
export function distanciaKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * El recorrido de un día: la distancia entre las paradas entregadas, en el
 * orden en que se entregaron, por `FACTOR_DE_RECORRIDO`. Una sola parada no
 * tiene tramo (el depósito no se conoce), así que el día vale 0 km con 1 pedido.
 */
export function usoDelDia(
  day: string,
  paradas: readonly ParadaEntregada[],
): UsoDelDia {
  const ordenadas = [...paradas].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  let km = 0;
  for (let i = 1; i < ordenadas.length; i += 1) {
    km += distanciaKm(ordenadas[i - 1], ordenadas[i]);
  }
  const horas =
    ordenadas.length > 1
      ? (ordenadas[ordenadas.length - 1].at.getTime() -
          ordenadas[0].at.getTime()) /
        3_600_000
      : 0;
  return {
    day,
    km: km * FACTOR_DE_RECORRIDO,
    orders: ordenadas.length,
    routeHours: Math.min(24, horas),
  };
}

/** Los días `(desde, hasta]`: desde el día siguiente a la primera lectura hasta el día de la segunda. */
function diasEntreLecturas(desde: string, hasta: string): string[] {
  if (hasta <= desde) return hasta === desde ? [hasta] : [];
  const dias: string[] = [];
  for (let d = sumarDias(desde, 1); d <= hasta; d = sumarDias(d, 1))
    dias.push(d);
  return dias;
}

/**
 * Calibra lo estimado por recorrido con el odómetro. Entre dos lecturas
 * consecutivas la diferencia de kilómetros es lo recorrido de verdad: se
 * reparte entre los días de ese tramo en proporción a lo estimado de cada uno
 * (en partes iguales si no se estimó nada), y reemplaza a la estimación. Los
 * días fuera de todo tramo conservan el recorrido estimado. Una lectura que no
 * sube respecto de la anterior (error de carga) se ignora.
 */
export function calibrarConOdometro(
  estimados: readonly UsoDelDia[],
  lecturas: readonly LecturaDeOdometro[],
): UsoDelDia[] {
  const porDia = new Map(estimados.map((u) => [u.day, { ...u }]));
  const ordenadas = [...lecturas].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  const validas: LecturaDeOdometro[] = [];
  for (const l of ordenadas) {
    const ultima = validas[validas.length - 1];
    if (!ultima || l.km > ultima.km) validas.push(l);
  }

  for (let i = 1; i < validas.length; i += 1) {
    const delta = validas[i].km - validas[i - 1].km;
    const dias = diasEntreLecturas(
      diaArgentino(validas[i - 1].at),
      diaArgentino(validas[i].at),
    );
    if (dias.length === 0 || delta <= 0) continue;
    const pesos = dias.map((d) => porDia.get(d)?.km ?? 0);
    const total = pesos.reduce((a, p) => a + p, 0);
    dias.forEach((d, j) => {
      const km = total > 0 ? (delta * pesos[j]) / total : delta / dias.length;
      const previo = porDia.get(d) ?? {
        day: d,
        km: 0,
        orders: 0,
        routeHours: 0,
      };
      porDia.set(d, { ...previo, km });
    });
  }
  return [...porDia.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
