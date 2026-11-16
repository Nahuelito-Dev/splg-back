import {
  OFFER_TRANSITIONS,
  PLANNED_TRANSITIONS,
} from '../../route-batch/domain/route-sheet.machine';
import { MENSAJES_DE_RESTRICCIONES } from '../../common/errors/restricciones-de-base';
import {
  crearFuncionDelLote,
  crearTriggerDelLote,
  paresDelLote,
  quitarTriggerDelLote,
  RESTRICCION_DEL_LOTE,
  TablaDeEstados,
  TRANSICIONES_DEL_LOTE,
} from './transicion-lote-de-recorrido';

/** Sólo los estados desde los que se puede salir, con sus destinos ordenados. */
const normalizar = (t: TablaDeEstados): Record<string, string[]> =>
  Object.fromEntries(
    Object.keys(t)
      .filter((k) => t[k].length > 0)
      .sort()
      .map((k) => [k, [...t[k]].sort()]),
  );

describe('Trigger de transición de estado del lote de recorrido', () => {
  it('la tabla de la oferta es la del dominio', () => {
    expect(normalizar(TRANSICIONES_DEL_LOTE.offer)).toEqual(
      normalizar(OFFER_TRANSITIONS),
    );
  });

  it('la tabla de la hoja es la del dominio', () => {
    expect(normalizar(TRANSICIONES_DEL_LOTE.planned)).toEqual(
      normalizar(PLANNED_TRANSITIONS),
    );
  });

  it('el SQL lleva todos los pares por modalidad, la restricción y el bypass', () => {
    const funcion = crearFuncionDelLote();
    for (const par of paresDelLote()) expect(funcion).toContain(`'${par}'`);
    expect(paresDelLote()).toContain('planned:confirmed>draft');
    expect(paresDelLote()).not.toContain('offer:forming>draft');
    expect(funcion).toContain(RESTRICCION_DEL_LOTE);
    expect(funcion).toContain('splg.bypass_transiciones');
    expect(funcion).toContain('OLD."kind" IS DISTINCT FROM NEW."kind"');
    expect(crearTriggerDelLote()).toContain(
      'BEFORE UPDATE OF "status", "kind" ON "route_batch"',
    );
    expect(quitarTriggerDelLote()).toHaveLength(2);
  });

  // Con filas no se puede distinguir la validación por modalidad de la unión de las
  // dos tablas: CHK_route_batch_estados_oferta / _hoja impiden que una fila de una
  // modalidad esté en un estado de la otra, así que una transición que sólo vale
  // en una tabla nunca se intenta en la otra. Por eso se verifica el SQL.
  it('el par que se busca lleva la modalidad de la fila (NEW.kind), no una fija, y ningún par es de las dos', () => {
    expect(crearFuncionDelLote()).toContain(
      `(NEW."kind"::text || ':' || OLD."status"::text || '>' || NEW."status"::text) = ANY`,
    );
    const pares = paresDelLote();
    expect(pares.filter((p) => p.startsWith('offer:'))).not.toHaveLength(0);
    expect(pares.filter((p) => p.startsWith('planned:'))).not.toHaveLength(0);
    // Los únicos pares iguales en las dos modalidades son los del estado compartido.
    const sinModalidad = pares.map((p) => p.split(':')[1]);
    const repetidos = sinModalidad.filter(
      (p, i) => sinModalidad.indexOf(p) !== i,
    );
    expect(repetidos).toEqual(['assigned>completed']);
  });

  it('la restricción tiene su mensaje en castellano', () => {
    expect(MENSAJES_DE_RESTRICCIONES).toHaveProperty(RESTRICCION_DEL_LOTE);
  });
});
