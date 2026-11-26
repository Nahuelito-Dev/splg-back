import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';
import { AssignmentMethod } from '../entities/order.entity';

/** Una oferta del período, tal como la lee la consulta. */
export interface OfertaMedida {
  orderId: string;
  driverId: string;
  driverName: string;
  status: DispatchOfferStatus | `${DispatchOfferStatus}`;
  offeredAt: Date;
  respondedAt: Date | null;
  /** Minutos estimados al cliente al ofrecer (ausente o null: sin estimación). */
  estimatedMinutes?: number | null;
  /** Con qué se estimó: por calle (`osrm`) o en línea recta (`haversine`). */
  estimateSource?: 'osrm' | 'haversine' | null;
}

/** Un pedido con oferta en el período, con el desenlace de su espera. */
export interface PedidoMedido {
  /** Desde cuándo se pudo ofrecer a los choferes. */
  esperaDesde: Date;
  /** Cuándo lo aceptó un chofer (null: nadie lo tomó). */
  aceptadoEn: Date | null;
}

export interface EntradaDeMetricas {
  /** Método de asignación de cada pedido asignado en el período (`null`: sin dato). */
  metodosDeAsignacion: Array<AssignmentMethod | null>;
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

export interface AsignacionPorMetodo {
  method: AssignmentMethod;
  cantidad: number;
  /** Sobre los pedidos asignados que tienen método, 0 a 100; null si no hay ninguno. */
  porcentaje: number | null;
}

export interface MetricasDeDespacho {
  /** Pedidos asignados en el período (aceptados por un chofer o asignados a mano). */
  pedidosAsignados: number;
  /** De ellos, los anteriores al registro del método: no se inventa. */
  asignadosSinMetodo: number;
  asignacionPorMetodo: AsignacionPorMetodo[];
  pedidosDespachados: number;
  ofertasPorPedido: number | null;
  /** Sobre las ofertas ya resueltas (aceptada, rechazada o vencida), 0 a 100. */
  porcentajeAceptadas: number | null;
  porcentajeRechazadas: number | null;
  porcentajeVencidas: number | null;
  respuestaDelChofer: TiempoEnSegundos;
  hastaAsignar: TiempoEnSegundos;
  pedidosSinChofer: number;
  /** Ofertas (no retiradas) que guardaron un tiempo estimado: la base de las dos cifras siguientes. */
  ofertasConEstimacion: number;
  /** De ellas, las que se ordenaron con OSRM y no con la línea recta, 0 a 100. */
  porcentajeOrdenadasPorOsrm: number | null;
  /** Promedio de los minutos estimados al cliente al ofrecer. */
  minutosEstimadosPromedio: number | null;
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

  const conEstimacion = ofertas.filter(
    (o) =>
      typeof o.estimatedMinutes === 'number' &&
      Number.isFinite(o.estimatedMinutes) &&
      !!o.estimateSource,
  );

  const esperas = entrada.pedidos
    .filter((p) => p.aceptadoEn !== null)
    .map((p) => segundosEntre(p.esperaDesde, p.aceptadoEn as Date));

  const conMetodo = entrada.metodosDeAsignacion.filter(
    (m): m is AssignmentMethod => m !== null,
  );
  const asignacionPorMetodo = Object.values(AssignmentMethod).map(
    (method): AsignacionPorMetodo => {
      const cantidad = conMetodo.filter((m) => m === method).length;
      return {
        method,
        cantidad,
        porcentaje: porcentaje(cantidad, conMetodo.length),
      };
    },
  );

  return {
    pedidosAsignados: entrada.metodosDeAsignacion.length,
    asignadosSinMetodo: entrada.metodosDeAsignacion.length - conMetodo.length,
    asignacionPorMetodo,
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
    ofertasConEstimacion: conEstimacion.length,
    porcentajeOrdenadasPorOsrm: porcentaje(
      conEstimacion.filter((o) => o.estimateSource === 'osrm').length,
      conEstimacion.length,
    ),
    minutosEstimadosPromedio:
      conEstimacion.length === 0
        ? null
        : redondear(
            conEstimacion.reduce(
              (t, o) => t + (o.estimatedMinutes as number),
              0,
            ) / conEstimacion.length,
          ),
    topChoferes,
  };
}
