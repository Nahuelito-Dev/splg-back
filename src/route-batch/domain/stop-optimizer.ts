/**
 * Orden de las paradas de una hoja (heurística explicable, sin I/O).
 *
 *  1. Soluciones iniciales, con las franjas en cuenta: vecino más cercano
 *     (cuando una parada no llega a tiempo queda aparte) y construcción por
 *     inserción en orden de cierre de franja (cada parada va en la posición
 *     factible que menos retrasa el fin). Se sigue con la mejor de las dos.
 *  2. Mejora local: 2-opt y Or-opt (mover 1 a 3 paradas seguidas, con o sin
 *     invertirlas). Sólo se acepta un movimiento que mejora la calidad
 *     (primero: menos paradas tarde; después: antes se termina; después:
 *     menos kilómetros) y que no deja tarde una parada que ya llegaba en
 *     franja: se compara el conjunto de las tardías, no sólo cuántas son.
 *  3. Las paradas que quedaron aparte se reintentan en todas las posiciones
 *     de la hoja ya mejorada; sólo se saca de la hoja (`excluded`) la que
 *     no entra en ninguna sin dejar otra tarde.
 *  4. Hasta `MAX_EXACTO` paradas libres y sin fijadas, la búsqueda exacta
 *     (todas las secuencias, podando las que ya llegan tarde) corrige lo que
 *     la heurística hubiera dejado de más; sólo corre sin paradas fijadas y
 *     sólo reemplaza al resultado si es estrictamente mejor. Con más
 *     paradas el resultado es heurístico, pero antes de dejar una parada
 *     afuera se busca una secuencia con todas en franja
 *     (`buscarSecuenciaFactible`, con un tope de nodos): `excluded` dice si
 *     está probado que no entra (`window`), si no entra por la capacidad
 *     (`capacity`) o si no se pudo probar (`window_unverified`, también con
 *     paradas fijadas).
 *  5. Las paradas con `locked` conservan su posición exacta; las demás se
 *     reparten en los lugares libres.
 *
 * Es determinista: los empates se resuelven por franja, antigüedad e id.
 */
import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { assertValidStops } from './route-input';
import {
  computeSchedule,
  RouteStop,
  Schedule,
  ScheduleParams,
  ScheduleScore,
  scoreSchedule,
} from './eta';

// Alias: `Math.*` directo es varias veces más lento bajo Jest (contexto global del sandbox).
const { round, max, min, abs } = Math;

/**
 * Por qué una parada quedó fuera de la hoja:
 *  - `window`: está probado que no llega en franja (con las demás que entran);
 *  - `capacity`: en franja entraría, pero el vehículo no la carga (`accept`);
 *  - `window_unverified`: la heurística no la pudo ubicar y la búsqueda de una
 *    secuencia factible se cortó por el tope de nodos (o hay paradas fijadas):
 *    puede que sí entrara.
 */
export type ExcludedReason = 'window' | 'capacity' | 'window_unverified';

export interface ExcludedStop {
  id: string;
  reason: ExcludedReason;
}

export interface OptimizeOptions {
  /**
   * Tope de nodos de la búsqueda de una secuencia factible para una parada que
   * quedó afuera (`MAX_NODOS_DE_FACTIBILIDAD` por omisión).
   */
  maxSearchNodes?: number;
  /**
   * `exclude` (por omisión): una parada libre que igual llega tarde se saca de
   * la hoja. `keep`: se deja y queda marcada tarde (edición manual).
   */
  lateStops?: 'exclude' | 'keep';
  /** Tope de movimientos aceptados en la mejora local (0 la desactiva, y también la búsqueda exacta). */
  maxMoves?: number;
  /**
   * Restricción que depende del orden y que el optimizador no conoce (la
   * capacidad del vehículo con sus retiros). Un orden que no la cumple siempre
   * pierde contra uno que sí, así que la mejora local repara el que arrancó mal
   * y no introduce uno nuevo.
   */
  accept?: (order: readonly RouteStop[]) => boolean;
}

export interface OptimizeResult {
  /** Ids en el orden final. */
  order: string[];
  stops: RouteStop[];
  schedule: Schedule;
  excluded: ExcludedStop[];
  /** Minutos que ahorró la mejora local respecto del vecino más cercano. */
  savedMinutes: number;
  /** Movimientos aceptados por 2-opt / Or-opt. */
  moves: number;
}

const MAX_MOVIMIENTOS_POR_OMISION = 500;
const MS_POR_MINUTO = 60_000;
/** Diferencia mínima para considerar que una calidad es mejor (1 ms). */
const EPSILON_MS = 1;
const EPSILON_KM = 1e-6;

export interface Calidad {
  /** 1 si el orden no cumple la restricción externa (`accept`). */
  invalid: number;
  late: number;
  finishMs: number;
  km: number;
}

const calidadDe = (s: ScheduleScore, invalid: boolean): Calidad => ({
  invalid: invalid ? 1 : 0,
  late: s.lateCount,
  finishMs: s.finishMs,
  km: s.totalKm,
});

/** ¿`a` es estrictamente mejor que `b`? */
function esMejor(a: Calidad, b: Calidad): boolean {
  if (a.invalid !== b.invalid) return a.invalid < b.invalid;
  if (a.late !== b.late) return a.late < b.late;
  if (abs(a.finishMs - b.finishMs) >= EPSILON_MS) {
    return a.finishMs < b.finishMs;
  }
  return b.km - a.km > EPSILON_KM;
}

const desempate = (a: RouteStop, b: RouteStop): number =>
  a.windowStartMs - b.windowStartMs ||
  (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) ||
  a.id.localeCompare(b.id);

const enVivo = (p: ScheduleParams, a: RouteStop, primera: boolean): boolean =>
  primera && p.firstLeg?.stopId === a.id;

/**
 * Vecino más cercano con franjas sobre las paradas libres. No conoce las
 * fijadas: éstas se meten después en su lugar. Una parada que llegaría con la
 * franja ya cerrada no se pierde: queda en `excluidas` para reinsertarla.
 */
function vecinoMasCercano(
  libres: readonly RouteStop[],
  p: ScheduleParams,
): { orden: RouteStop[]; excluidas: RouteStop[] } {
  const pendientes = [...libres];
  const orden: RouteStop[] = [];
  const excluidas: RouteStop[] = [];
  let donde = p.originPoint;
  let reloj = p.startMs;
  const servicioMs = round(p.serviceMinutes * MS_POR_MINUTO);

  while (pendientes.length > 0) {
    const cierraPrimero = min(...pendientes.map((s) => s.windowEndMs));
    const urgentes = pendientes.filter((s) => s.windowStartMs <= cierraPrimero);
    if (urgentes.length === 0) {
      throw new InvalidRouteInputError(
        'ninguna franja abre antes de que cierre la primera',
      );
    }
    const tramoHasta = (desde: number, a: RouteStop): number =>
      enVivo(p, a, orden.length === 0)
        ? (p.firstLeg as { minutes: number }).minutes
        : p.matrix.minutes[desde][a.point];
    const llegadaA = (a: RouteStop): number =>
      max(round(reloj + tramoHasta(donde, a) * MS_POR_MINUTO), a.windowStartMs);
    // Admisible: llega a tiempo y, después de atenderla, todavía se llega a
    // tiempo (yendo directo) a cada una de las que quedan. Sin esto el más
    // cercano puede cerrarle el paso a una franja que vencía antes.
    const admisible = (a: RouteStop): boolean => {
      const llegada = llegadaA(a);
      if (llegada > a.windowEndMs) return false;
      const sale = llegada + servicioMs;
      return pendientes.every(
        (q) =>
          q === a ||
          max(
            round(sale + p.matrix.minutes[a.point][q.point] * MS_POR_MINUTO),
            q.windowStartMs,
          ) <= q.windowEndMs,
      );
    };
    const candidatas = urgentes.filter(admisible);
    const elegida = [...(candidatas.length > 0 ? candidatas : urgentes)].sort(
      (a, b) => tramoHasta(donde, a) - tramoHasta(donde, b) || desempate(a, b),
    )[0];
    pendientes.splice(pendientes.indexOf(elegida), 1);

    const llegada = llegadaA(elegida);
    if (llegada > elegida.windowEndMs) {
      excluidas.push(elegida);
      continue;
    }
    orden.push(elegida);
    reloj = llegada + servicioMs;
    donde = elegida.point;
  }
  return { orden, excluidas };
}

/**
 * Construcción por inserción: las paradas en orden de cierre de franja, cada
 * una en la posición factible (todas en franja) que menos retrasa el fin. La
 * que no tiene ninguna queda aparte. Complementa al vecino más cercano, que
 * ignora lo que queda por delante cuando las franjas son angostas.
 */
function porInsercion(
  libres: readonly RouteStop[],
  p: ScheduleParams,
): { orden: RouteStop[]; excluidas: RouteStop[] } {
  const ordenadas = [...libres].sort(
    (a, b) => a.windowEndMs - b.windowEndMs || desempate(a, b),
  );
  let orden: RouteStop[] = [];
  const excluidas: RouteStop[] = [];
  for (const s of ordenadas) {
    let mejor: { orden: RouteStop[]; score: ScheduleScore } | null = null;
    for (let pos = 0; pos <= orden.length; pos++) {
      const cand = [...orden.slice(0, pos), s, ...orden.slice(pos)];
      const score = scoreSchedule(cand, p);
      if (score.lateCount > 0) continue;
      if (
        mejor === null ||
        score.finishMs < mejor.score.finishMs - EPSILON_MS ||
        (abs(score.finishMs - mejor.score.finishMs) < EPSILON_MS &&
          score.totalKm < mejor.score.totalKm - EPSILON_KM)
      ) {
        mejor = { orden: cand, score };
      }
    }
    if (mejor) orden = mejor.orden;
    else excluidas.push(s);
  }
  return { orden, excluidas };
}

/** Une las fijadas (en su posición) con las libres (en los lugares que quedan). */
function unir(
  fijadas: ReadonlyArray<{ index: number; stop: RouteStop }>,
  libres: readonly RouteStop[],
): RouteStop[] {
  const total = fijadas.length + libres.length;
  const resultado: Array<RouteStop | undefined> = new Array<
    RouteStop | undefined
  >(total).fill(undefined);
  let previa = -1;
  fijadas.forEach(({ index, stop }, k) => {
    const hastaAca = total - (fijadas.length - k);
    const lugar = max(min(index, hastaAca), previa + 1);
    resultado[lugar] = stop;
    previa = lugar;
  });
  let siguiente = 0;
  for (let i = 0; i < total; i++) {
    resultado[i] ??= libres[siguiente++];
  }
  return resultado as RouteStop[];
}

/** Todas las variantes de la lista libre por 2-opt y por Or-opt, en orden fijo. */
function* vecindario(libres: readonly RouteStop[]): Generator<RouteStop[]> {
  const m = libres.length;
  for (let i = 0; i < m - 1; i++) {
    for (let j = i + 1; j < m; j++) {
      yield [
        ...libres.slice(0, i),
        ...libres.slice(i, j + 1).reverse(),
        ...libres.slice(j + 1),
      ];
    }
  }
  for (let largo = 1; largo <= min(3, m - 1); largo++) {
    for (let i = 0; i + largo <= m; i++) {
      const segmento = libres.slice(i, i + largo);
      const resto = [...libres.slice(0, i), ...libres.slice(i + largo)];
      for (let k = 0; k <= resto.length; k++) {
        const derecho = [...resto.slice(0, k), ...segmento, ...resto.slice(k)];
        if (k !== i) yield derecho;
        if (largo > 1) {
          yield [
            ...resto.slice(0, k),
            ...[...segmento].reverse(),
            ...resto.slice(k),
          ];
        }
      }
    }
  }
}

export interface BusquedaLocal {
  calidad: (orden: readonly RouteStop[]) => Calidad;
  /** Ids de las paradas que llegan tarde en ese orden. */
  tardias: (orden: readonly RouteStop[]) => Set<string>;
  maxMovimientos: number;
}

/**
 * 2-opt y Or-opt desde `inicio` hasta que ningún movimiento mejora. Un
 * movimiento sólo se acepta si mejora la calidad y, cuando hay paradas tarde,
 * no deja tarde una que llegaba en franja (se compara el conjunto de las
 * tardías, no sólo cuántas son). `conservarFranjas = false` existe para probar
 * esa regla.
 */
export function mejorarLocal(
  inicio: RouteStop[],
  ctx: BusquedaLocal,
  conservarFranjas = true,
): { actual: RouteStop[]; moves: number } {
  let actual = inicio;
  let actualCalidad = ctx.calidad(actual);
  let moves = 0;
  while (moves < ctx.maxMovimientos) {
    const yaTarde =
      conservarFranjas && actualCalidad.late > 0 ? ctx.tardias(actual) : null;
    let mejor: RouteStop[] | null = null;
    let calidadMejor = actualCalidad;
    for (const candidata of vecindario(actual)) {
      const c = ctx.calidad(candidata);
      if (!esMejor(c, calidadMejor)) continue;
      if (
        yaTarde &&
        ![...ctx.tardias(candidata)].every((id) => yaTarde.has(id))
      ) {
        continue;
      }
      mejor = candidata;
      calidadMejor = c;
    }
    if (!mejor) break;
    actual = mejor;
    actualCalidad = calidadMejor;
    moves++;
  }
  return { actual, moves };
}

/** Hasta cuántas paradas libres se prueba toda secuencia posible. */
export const MAX_EXACTO = 8;

interface Exacta {
  orden: RouteStop[];
  excluidas: RouteStop[];
}

/**
 * Búsqueda exacta sobre pocas paradas libres (sin fijadas). Con `podar` una
 * secuencia que ya llega tarde se corta y se registra cada prefijo en franja
 * (el resto queda aparte: la hoja más larga posible, después la que antes
 * termina). Sin `podar` se prueban las secuencias completas y se cuentan las
 * tardías.
 */
function busquedaExacta(
  libres: readonly RouteStop[],
  p: ScheduleParams,
  aceptar: (orden: readonly RouteStop[]) => boolean,
  podar: boolean,
): Exacta {
  const todas = [...libres].sort(desempate);
  const n = todas.length;
  const servicioMs = round(p.serviceMinutes * MS_POR_MINUTO);
  const prefijo: RouteStop[] = [];
  const usado = new Array<boolean>(n).fill(false);
  let mejor: { orden: RouteStop[]; calidad: Calidad } | null = null;

  const registrar = (reloj: number, km: number, tardias: number): void => {
    const calidad: Calidad = {
      invalid: prefijo.length === 0 || aceptar(prefijo) ? 0 : 1,
      late: n - prefijo.length + tardias,
      finishMs: prefijo.length > 0 ? reloj : p.startMs,
      km,
    };
    if (mejor === null || esMejor(calidad, mejor.calidad)) {
      mejor = { orden: [...prefijo], calidad };
    }
  };
  const visitar = (
    reloj: number,
    donde: number,
    km: number,
    tardias: number,
  ) => {
    if (podar || prefijo.length === n) registrar(reloj, km, tardias);
    for (let i = 0; i < n; i++) {
      if (usado[i]) continue;
      const s = todas[i];
      const primera = prefijo.length === 0;
      const tramo = enVivo(p, s, primera)
        ? (p.firstLeg as { minutes: number; km: number })
        : {
            minutes: p.matrix.minutes[donde][s.point],
            km: p.matrix.km[donde][s.point],
          };
      const llegada = max(
        round(reloj + tramo.minutes * MS_POR_MINUTO),
        s.windowStartMs,
      );
      const tarde = llegada > s.windowEndMs;
      if (tarde && podar) continue;
      usado[i] = true;
      prefijo.push(s);
      visitar(
        llegada + servicioMs,
        s.point,
        km + tramo.km,
        tardias + (tarde ? 1 : 0),
      );
      prefijo.pop();
      usado[i] = false;
    }
  };
  visitar(p.startMs, p.originPoint, 0, 0);
  const elegida = mejor as { orden: RouteStop[] } | null;
  const orden = elegida?.orden ?? [];
  const dentro = new Set(orden.map((s) => s.id));
  return { orden, excluidas: todas.filter((s) => !dentro.has(s.id)) };
}

/** Tope de nodos de la búsqueda de factibilidad (de toda la verificación de una hoja). */
export const MAX_NODOS_DE_FACTIBILIDAD = 500_000;

/** Más paradas que éstas no caben en la máscara de bits de la búsqueda: queda sin probar. */
export const MAX_PARADAS_DE_FACTIBILIDAD = 52;

export interface Factibilidad {
  /**
   * `found`: hay una secuencia con todas en franja (en `orden`); `none`: está
   * probado que no hay; `unknown`: se agotó el tope de nodos.
   */
  estado: 'found' | 'none' | 'unknown';
  orden: RouteStop[];
  /** Nodos que recorrió la búsqueda (para repartir un presupuesto entre varias). */
  nodos: number;
}

/**
 * ¿Existe una secuencia con TODAS las paradas dentro de su franja? Búsqueda en
 * profundidad con poda: se corta la rama cuando una parada llega tarde, o
 * cuando alguna de las que faltan ya no puede llegar ni con el mejor tramo de
 * entrada que tiene; y se recuerdan los estados sin salida (mismas paradas
 * hechas, mismo punto, reloj igual o más tarde). Las paradas se prueban por
 * cierre de franja. Sin `aceptar` es una prueba de factibilidad pura; con
 * `aceptar` (capacidad) sólo cuenta una secuencia completa que lo cumpla.
 */
export function buscarSecuenciaFactible(
  stops: readonly RouteStop[],
  p: ScheduleParams,
  tope = MAX_NODOS_DE_FACTIBILIDAD,
  aceptar?: (orden: readonly RouteStop[]) => boolean,
): Factibilidad {
  const todas = [...stops].sort(
    (a, b) => a.windowEndMs - b.windowEndMs || desempate(a, b),
  );
  const n = todas.length;
  if (n === 0) return { estado: 'found', orden: [], nodos: 0 };
  // La máscara de paradas hechas es un número (2 ** i): hasta 52 paradas es exacta.
  if (n > MAX_PARADAS_DE_FACTIBILIDAD) {
    return { estado: 'unknown', orden: [], nodos: 0 };
  }
  const servicioMs = round(p.serviceMinutes * MS_POR_MINUTO);
  const puntos = [p.originPoint, ...todas.map((s) => s.point)];
  // Mejor tramo con que se puede llegar a cada parada, desde cualquier lado.
  const entrada = todas.map((s, i) => {
    let mejor = Infinity;
    puntos.forEach((x, k) => {
      if (k === i + 1) return;
      mejor = min(mejor, p.matrix.minutes[x][s.point]);
    });
    if (p.firstLeg?.stopId === s.id) mejor = min(mejor, p.firstLeg.minutes);
    return round(mejor * MS_POR_MINUTO);
  });

  const usado = new Array<boolean>(n).fill(false);
  const prefijo: RouteStop[] = [];
  const fallos = new Map<string, number>();
  let nodos = 0;
  let agotado = false;

  const buscar = (reloj: number, donde: number, mascara: number): boolean => {
    if (prefijo.length === n) return !aceptar || aceptar(prefijo);
    if (++nodos > tope) {
      agotado = true;
      return false;
    }
    const clave = `${mascara}|${donde}`;
    if (!aceptar) {
      const previo = fallos.get(clave);
      if (previo !== undefined && previo <= reloj) return false;
    }
    let posible = true;
    for (let j = 0; j < n && posible; j++) {
      if (!usado[j] && reloj + entrada[j] > todas[j].windowEndMs)
        posible = false;
    }
    if (posible) {
      for (let i = 0; i < n; i++) {
        if (usado[i]) continue;
        const s = todas[i];
        const tramo = enVivo(p, s, prefijo.length === 0)
          ? (p.firstLeg as { minutes: number }).minutes
          : p.matrix.minutes[donde][s.point];
        const llegada = max(
          round(reloj + tramo * MS_POR_MINUTO),
          s.windowStartMs,
        );
        if (llegada > s.windowEndMs) continue;
        usado[i] = true;
        prefijo.push(s);
        if (buscar(llegada + servicioMs, s.point, mascara + 2 ** i))
          return true;
        prefijo.pop();
        usado[i] = false;
        if (agotado) return false;
      }
    }
    if (!aceptar) fallos.set(clave, reloj);
    return false;
  };

  if (buscar(p.startMs, p.originPoint, 0)) {
    return { estado: 'found', orden: [...prefijo], nodos };
  }
  return { estado: agotado ? 'unknown' : 'none', orden: [], nodos };
}

export function optimizeStops(
  stops: readonly RouteStop[],
  params: ScheduleParams,
  options: OptimizeOptions = {},
): OptimizeResult {
  assertValidStops(stops, params.matrix, params.originPoint);
  const politica = options.lateStops ?? 'exclude';
  const maxMovimientos = options.maxMoves ?? MAX_MOVIMIENTOS_POR_OMISION;

  const fijadas = stops
    .map((stop, index) => ({ index, stop }))
    .filter((e) => e.stop.locked === true);
  const libres = stops.filter((s) => s.locked !== true);

  const armar = (l: readonly RouteStop[]): RouteStop[] =>
    fijadas.length === 0 ? (l as RouteStop[]) : unir(fijadas, l);
  const aceptar = options.accept ?? (() => true);
  /** Calidad del orden libre `l` una vez unido a las fijadas (una sola unión por evaluación). */
  const calidad = (l: readonly RouteStop[]): Calidad => {
    const completo = armar(l);
    return calidadDe(scoreSchedule(completo, params), !aceptar(completo));
  };
  const tardias = (l: readonly RouteStop[]): Set<string> =>
    new Set(
      computeSchedule(armar(l), params)
        .stops.filter((s) => s.late)
        .map((s) => s.id),
    );

  const mejorar = (inicio: RouteStop[]) =>
    mejorarLocal(inicio, { calidad, tardias, maxMovimientos });

  /** Prueba cada parada aparte en todas las posiciones; entra la que no suma tardías. */
  const idsFijadas = new Set(fijadas.map((f) => f.stop.id));
  const reinsertar = (
    actual: RouteStop[],
    aparte: RouteStop[],
  ): { actual: RouteStop[]; aparte: RouteStop[]; entro: boolean } => {
    let entro = false;
    let cola = [...aparte].sort(
      (a, b) => a.windowEndMs - b.windowEndMs || desempate(a, b),
    );
    let avance = true;
    while (avance) {
      avance = false;
      for (const s of cola) {
        const base = calidad(actual);
        let mejor: { orden: RouteStop[]; c: Calidad } | null = null;
        for (let pos = 0; pos <= actual.length; pos++) {
          const cand = [...actual.slice(0, pos), s, ...actual.slice(pos)];
          const c = calidad(cand);
          if (c.invalid > base.invalid || c.late > base.late) continue;
          // Con fijadas, el mismo número de tardías puede ser otra parada: la
          // tardanza de una fijada no se le pasa a una libre.
          if (
            fijadas.length > 0 &&
            [...tardias(cand)].some((id) => !idsFijadas.has(id))
          ) {
            continue;
          }
          if (mejor === null || esMejor(c, mejor.c)) mejor = { orden: cand, c };
        }
        if (mejor) {
          actual = mejor.orden;
          cola = cola.filter((q) => q !== s);
          avance = true;
          entro = true;
          break;
        }
      }
    }
    return { actual, aparte: cola, entro };
  };

  interface Armado {
    actual: RouteStop[];
    aparte: RouteStop[];
    moves: number;
    terminoInicial: number;
  }
  /** De una construcción inicial al orden final: mejora, saca lo que llega tarde y reintenta lo que quedó aparte. */
  const resolver = (inicial: {
    orden: RouteStop[];
    excluidas: RouteStop[];
  }): Armado => {
    let actual =
      politica === 'exclude'
        ? inicial.orden
        : [...inicial.orden, ...inicial.excluidas];
    let aparte = politica === 'exclude' ? [...inicial.excluidas] : [];
    const terminoInicial = calidad(actual).finishMs;
    let moves = 0;
    for (let vuelta = 0; vuelta <= libres.length + 1; vuelta++) {
      const m = mejorar(actual);
      actual = m.actual;
      moves += m.moves;
      let cambio = false;
      if (politica === 'exclude') {
        // Una libre que igual llega tarde (por las fijadas) se saca, de a una.
        const tarde = computeSchedule(armar(actual), params).stops.find(
          (s) => s.late && libres.some((l) => l.id === s.id),
        );
        if (tarde) {
          aparte.push(actual.find((s) => s.id === tarde.id) as RouteStop);
          actual = actual.filter((s) => s.id !== tarde.id);
          cambio = true;
        }
        if (aparte.length > 0) {
          const r = reinsertar(actual, aparte);
          actual = r.actual;
          aparte = r.aparte;
          cambio = cambio || r.entro;
        }
      }
      if (!cambio) break;
    }
    return { actual, aparte, moves, terminoInicial };
  };
  const calidadFinal = (a: Armado): Calidad => {
    const c = calidad(a.actual);
    return { ...c, late: c.late + a.aparte.length };
  };

  // Se parte del vecino más cercano; con `keep` también cuenta el orden que ya
  // tenía la hoja. Sólo si queda algo tarde o aparte se prueba la construcción
  // por inserción (más cara) y se sigue con la mejor.
  const vecino = vecinoMasCercano(libres, params);
  let partida = vecino;
  if (politica === 'keep') {
    const delVecino = [...vecino.orden, ...vecino.excluidas];
    partida = esMejor(calidad(libres), calidad(delVecino))
      ? { orden: [...libres], excluidas: [] }
      : { orden: delVecino, excluidas: [] };
  }
  let armado = resolver(partida);
  if (libres.length > 1 && calidadFinal(armado).late > 0) {
    const candidato = resolver(porInsercion(libres, params));
    if (esMejor(calidadFinal(candidato), calidadFinal(armado))) {
      armado = candidato;
    }
  }
  let elegido = armado;

  if (
    maxMovimientos > 0 &&
    fijadas.length === 0 &&
    libres.length > 1 &&
    libres.length <= MAX_EXACTO &&
    (politica === 'exclude' || calidad(elegido.actual).late > 0)
  ) {
    const e = busquedaExacta(libres, params, aceptar, politica === 'exclude');
    const exacto: Armado = {
      actual: e.orden,
      aparte: politica === 'exclude' ? e.excluidas : [],
      moves: elegido.moves,
      terminoInicial: elegido.terminoInicial,
    };
    if (esMejor(calidadFinal(exacto), calidadFinal(elegido))) elegido = exacto;
  }

  // Lo que quedó afuera se verifica con la búsqueda de factibilidad: si hay una
  // secuencia con todas en franja se usa (y se mejora la distancia sin romper
  // franjas); si no, el motivo dice qué se pudo probar.
  const razones = new Map<string, ExcludedReason>();
  if (politica === 'exclude' && elegido.aparte.length > 0) {
    if (fijadas.length > 0) {
      for (const s of elegido.aparte) razones.set(s.id, 'window_unverified');
    } else {
      // El presupuesto de nodos es de toda la verificación, no de cada parada.
      let presupuesto = options.maxSearchNodes ?? MAX_NODOS_DE_FACTIBILIDAD;
      let actual = elegido.actual;
      let moves = elegido.moves;
      let pendientes = [...elegido.aparte].sort(
        (a, b) => a.windowEndMs - b.windowEndMs || desempate(a, b),
      );
      let avance = true;
      while (avance) {
        avance = false;
        for (const s of pendientes) {
          const conjunto = [...actual, s];
          if (presupuesto <= 0) {
            razones.set(s.id, 'window_unverified');
            continue;
          }
          const con = buscarSecuenciaFactible(
            conjunto,
            params,
            presupuesto,
            options.accept,
          );
          presupuesto -= con.nodos;
          if (con.estado === 'found') {
            const m = mejorar(con.orden);
            actual = m.actual;
            moves += m.moves;
            pendientes = pendientes.filter((q) => q !== s);
            razones.delete(s.id);
            avance = true;
            break;
          }
          if (con.estado === 'unknown') {
            razones.set(s.id, 'window_unverified');
            continue;
          }
          // Con la capacidad no entra: ¿entraría en franja sin ella?
          const sin = options.accept
            ? buscarSecuenciaFactible(conjunto, params, max(presupuesto, 1))
            : con;
          if (options.accept) presupuesto -= sin.nodos;
          razones.set(
            s.id,
            sin.estado === 'found'
              ? 'capacity'
              : sin.estado === 'none'
                ? 'window'
                : 'window_unverified',
          );
        }
      }
      elegido = { ...elegido, actual, aparte: pendientes, moves };
    }
  }

  // Verificación final: en modo `exclude` ninguna parada libre queda tarde dentro
  // de la hoja (sólo una fijada puede llegar tarde, por decisión del administrador).
  if (politica === 'exclude') {
    for (;;) {
      const tarde = computeSchedule(armar(elegido.actual), params).stops.find(
        (st) => st.late && !idsFijadas.has(st.id),
      );
      if (!tarde) break;
      const parada = elegido.actual.find((st) => st.id === tarde.id);
      if (!parada) break;
      elegido = {
        ...elegido,
        actual: elegido.actual.filter((st) => st !== parada),
        aparte: [...elegido.aparte, parada],
      };
      razones.set(parada.id, 'window_unverified');
    }
  }

  const finales = armar(elegido.actual);
  const schedule = computeSchedule(finales, params);
  const ahorroMin = max(
    0,
    (elegido.terminoInicial - schedule.finishMs) / MS_POR_MINUTO,
  );
  const excluded: ExcludedStop[] = elegido.aparte.map((s) => ({
    id: s.id,
    reason: razones.get(s.id) ?? 'window',
  }));

  return {
    order: finales.map((s) => s.id),
    stops: finales,
    schedule,
    excluded,
    savedMinutes: ahorroMin,
    moves: elegido.moves,
  };
}
