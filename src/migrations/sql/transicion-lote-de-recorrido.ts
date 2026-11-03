/**
 * Trigger de transición de estado del lote de recorrido (`route_batch`), que
 * lo crea la migración `HojaDeRuta` y el arranque de la base de las pruebas de
 * integración. Es aparte de `transiciones-de-estado.ts` (copia congelada de las
 * máquinas que instalaron migraciones anteriores): el lote tiene dos tablas
 * según su modalidad y la modalidad no cambia.
 *
 * Las tablas de abajo son una COPIA CONGELADA de `OFFER_TRANSITIONS` y
 * `PLANNED_TRANSITIONS` (`route-batch/domain/route-sheet.machine.ts`);
 * `transicion-lote-de-recorrido.spec.ts` verifica que coinciden.
 *
 * - Una transición que la tabla de su modalidad no admite falla con SQLSTATE
 *   23514 y la restricción `CHK_route_batch_transicion_de_estado` (409).
 * - Cambiar `kind` de una fila falla con la misma restricción: un lote de
 *   oferta no se vuelve hoja ni al revés (ni siquiera con el bypass).
 * - Repetir el mismo estado no es una transición. El bypass de fixtures
 *   (`splg.bypass_transiciones`) saltea sólo la tabla de estados.
 */
export type TablaDeEstados = Readonly<Record<string, readonly string[]>>;

export const TRANSICIONES_DEL_LOTE: Readonly<
  Record<'offer' | 'planned', TablaDeEstados>
> = {
  offer: {
    forming: ['offered', 'dissolved'],
    offered: ['assigned', 'dissolved'],
    assigned: ['completed'],
    dissolved: [],
    completed: [],
  },
  planned: {
    draft: ['confirmed', 'dissolved'],
    confirmed: ['draft', 'assigned', 'dissolved'],
    assigned: ['completed'],
    dissolved: [],
    completed: [],
  },
};

export const RESTRICCION_DEL_LOTE = 'CHK_route_batch_transicion_de_estado';
export const TRIGGER_DEL_LOTE = 'TRG_route_batch_transicion_de_estado';
export const FUNCION_DEL_LOTE = 'transicion_de_estado_route_batch';

/** Pares «modalidad:desde>hacia» válidos, ordenados para que el SQL sea estable. */
export function paresDelLote(): string[] {
  return Object.entries(TRANSICIONES_DEL_LOTE)
    .flatMap(([kind, tabla]) =>
      Object.entries(tabla).flatMap(([desde, destinos]) =>
        destinos.map((hacia) => `${kind}:${desde}>${hacia}`),
      ),
    )
    .sort();
}

export function crearFuncionDelLote(): string {
  const pares = paresDelLote()
    .map((p) => `'${p}'`)
    .join(', ');
  return `CREATE FUNCTION ${FUNCION_DEL_LOTE}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
           RAISE EXCEPTION 'El lote no puede cambiar de modalidad (de % a %)', OLD."kind", NEW."kind"
             USING ERRCODE = '23514', CONSTRAINT = '${RESTRICCION_DEL_LOTE}';
         END IF;
         IF OLD."status" IS NOT DISTINCT FROM NEW."status"
            OR current_setting('splg.bypass_transiciones', true) = 'on'
            OR (NEW."kind"::text || ':' || OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[${pares}]) THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'El lote no puede pasar de % a %', OLD."status", NEW."status"
           USING ERRCODE = '23514', CONSTRAINT = '${RESTRICCION_DEL_LOTE}';
       END $$`;
}

export function crearTriggerDelLote(): string {
  return `CREATE TRIGGER "${TRIGGER_DEL_LOTE}" BEFORE UPDATE OF "status", "kind" ON "route_batch"
         FOR EACH ROW EXECUTE FUNCTION ${FUNCION_DEL_LOTE}()`;
}

export function quitarTriggerDelLote(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "${TRIGGER_DEL_LOTE}" ON "route_batch"`,
    `DROP FUNCTION IF EXISTS ${FUNCION_DEL_LOTE}()`,
  ];
}

/** Las sentencias que instalan el trigger del lote (para las bases de prueba). */
export function sentenciasDelLote(): string[] {
  return [crearFuncionDelLote(), crearTriggerDelLote()];
}
