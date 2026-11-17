import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';

/** Una oferta del período, tal como la lee la consulta. */
export interface OfertaMedida {
  orderId: string;
  driverId: string;
  driverName: string;
  status: DispatchOfferStatus | `${DispatchOfferStatus}`;
  offeredAt: Date;
  respondedAt: Date | null;
}

/** Un pedido con oferta en el período, con el desenlace de su espera. */
export interface PedidoMedido {
  /** Desde cuándo se pudo ofrecer a los choferes. */
  esperaDesde: Date;
  /** Cuándo lo aceptó un chofer (null: nadie lo tomó). */
  aceptadoEn: Date | null;
}

export interface EntradaDeMetricas {
  ofertas: OfertaMedida[];
  pedidos: PedidoMedido[];
  /** Pedidos que el sistema canceló porque ningún chofer los tomó. */
  sinChofer: number;
}

export interface TiempoEnSegundos {
  /** null cuando no hay datos para calcularlo. */
  mediana: number | null;
  p90: number | null;
}

export interface ChoferEnElTop {
  driverId: string;
  nombre: string;
  ofertas: number;
  aceptadas: number;
  tasaAceptacion: number;
  medianaRespuestaSegundos: number | null;
}

export interface MetricasDeDespacho {
  pedidosDespachados: number;
  ofertasPorPedido: number | null;
  /** Sobre las ofertas ya resueltas (aceptada, rechazada o vencida), 0 a 100. */
  porcentajeAceptadas: number | null;
  porcentajeRechazadas: number | null;
  porcentajeVencidas: number | null;
  respuestaDelChofer: TiempoEnSegundos;
  hastaAsignar: TiempoEnSegundos;
  pedidosSinChofer: number;
  topChoferes: ChoferEnElTop[];
}

/** Choferes con menos ofertas que esto no entran al top: la tasa no dice nada. */
export const MINIMO_OFERTAS_PARA_EL_TOP = 1;
export const TAMANO_DEL_TOP = 5;

const redondear = (n: number, decimales = 1): number => {
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
};

/** Percentil con interpolación lineal; null si no hay valores. `p` entre 0 y 100. */
export function percentil(
  valores: readonly number[],
  p: number,
): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const posicion = ((orden.length - 1) * p) / 100;
  const abajo = Math.floor(posicion);
  const arriba = Math.ceil(posicion);
  return orden[abajo] + (orden[arriba] - orden[abajo]) * (posicion - abajo);
}

export function mediana(valores: readonly number[]): number | null {
  return percentil(valores, 50);
}

function tiempo(valores: readonly number[]): TiempoEnSegundos {
  const m = mediana(valores);
  const p = percentil(valores, 90);
  return {
    mediana: m === null ? null : redondear(m),
    p90: p === null ? null : redondear(p),
  };
}

const segundosEntre = (desde: Date, hasta: Date): number =>
  Math.max(0, (hasta.getTime() - desde.getTime()) / 1000);

const porcentaje = (parte: number, total: number): number | null =>
  total === 0 ? null : redondear((parte * 100) / total);

/** Calcula las cifras del tablero «Cómo viene el despacho». Función pura. */
export function calcularMetricasDeDespacho(
  entrada: EntradaDeMetricas,
): MetricasDeDespacho {
  // Una oferta retirada (pedido editado o resuelto por otra vía) no es un intento.
  const ofertas = entrada.ofertas.filter(
    (o) => o.status !== DispatchOfferStatus.SUPERSEDED,
  );
  const pedidos = new Set(ofertas.map((o) => o.orderId));
  const resueltas = ofertas.filter(
    (o) => o.status !== DispatchOfferStatus.OFFERED,
  );
  const cuantas = (estado: DispatchOfferStatus): number =>
    resueltas.filter((o) => o.status === estado).length;

  const respuestas = (lista: OfertaMedida[]): number[] =>
    lista
      .filter((o) => o.respondedAt !== null)
      .map((o) => segundosEntre(o.offeredAt, o.respondedAt as Date));

  const porChofer = new Map<string, OfertaMedida[]>();
  for (const o of ofertas) {
    porChofer.set(o.driverId, [...(porChofer.get(o.driverId) ?? []), o]);
  }
  const topChoferes: ChoferEnElTop[] = [...porChofer.entries()]
    .map(([driverId, propias]) => {
      const cerradas = propias.filter(
        (o) => o.status !== DispatchOfferStatus.OFFERED,
      );
      const aceptadas = cerradas.filter(
        (o) => o.status === DispatchOfferStatus.ACCEPTED,
      ).length;
      const m = mediana(respuestas(propias));
      return {
        driverId,
        nombre: propias[0].driverName,
        ofertas: cerradas.length,
        aceptadas,
        tasaAceptacion: porcentaje(aceptadas, cerradas.length) ?? 0,
        medianaRespuestaSegundos: m === null ? null : redondear(m),
      };
    })
    .filter((c) => c.ofertas >= MINIMO_OFERTAS_PARA_EL_TOP)
    .sort(
      (a, b) =>
        b.tasaAceptacion - a.tasaAceptacion ||
        b.ofertas - a.ofertas ||
        a.nombre.localeCompare(b.nombre, 'es'),
    )
    .slice(0, TAMANO_DEL_TOP);

  const esperas = entrada.pedidos
    .filter((p) => p.aceptadoEn !== null)
    .map((p) => segundosEntre(p.esperaDesde, p.aceptadoEn as Date));

  return {
    pedidosDespachados: pedidos.size,
    ofertasPorPedido:
      pedidos.size === 0 ? null : redondear(ofertas.length / pedidos.size),
    porcentajeAceptadas: porcentaje(
      cuantas(DispatchOfferStatus.ACCEPTED),
      resueltas.length,
    ),
    porcentajeRechazadas: porcentaje(
      cuantas(DispatchOfferStatus.REJECTED),
      resueltas.length,
    ),
    porcentajeVencidas: porcentaje(
      cuantas(DispatchOfferStatus.EXPIRED),
      resueltas.length,
    ),
    respuestaDelChofer: tiempo(
      respuestas(
        ofertas.filter(
          (o) =>
            o.status === DispatchOfferStatus.ACCEPTED ||
            o.status === DispatchOfferStatus.REJECTED,
        ),
      ),
    ),
    hastaAsignar: tiempo(esperas),
    pedidosSinChofer: entrada.sinChofer,
    topChoferes,
  };
}
