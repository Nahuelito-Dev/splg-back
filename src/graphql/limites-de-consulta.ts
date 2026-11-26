import {
  GraphQLError,
  Kind,
  OperationTypeNode,
  type ASTNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';
import {
  createComplexityRule,
  fieldExtensionsEstimator,
  simpleEstimator,
} from 'graphql-query-complexity';

/**
 * Profundidad máxima de una consulta (el campo raíz cuenta 1). Los informes
 * llegan a 3 (`salesSummary { current { totalSales } }`): el margen es para
 * lo que se sume, no para anidar sin fin.
 */
export const PROFUNDIDAD_MAXIMA = 6;

/**
 * Complejidad máxima de una consulta: cada informe pesa 10 y cada campo 1.
 * Alcanza para pedir los cinco informes completos juntos (~90) y frena repetir
 * un informe con alias para multiplicar las consultas a la base.
 */
export const COMPLEJIDAD_MAXIMA = 100;

/** El `code` de una consulta rechazada por los límites (en `extensions.code`). */
export const CODIGO_CONSULTA_DEMASIADO_GRANDE = 'QUERY_TOO_COMPLEX';

/** El `code` de una operación que no es una consulta (`mutation`, `subscription`). */
export const CODIGO_OPERACION_NO_PERMITIDA = 'OPERATION_NOT_ALLOWED';

function rechazo(mensaje: string, code: string): GraphQLError {
  return new GraphQLError(mensaje, { extensions: { code, statusCode: 400 } });
}

function demasiadoGrande(mensaje: string): GraphQLError {
  return rechazo(mensaje, CODIGO_CONSULTA_DEMASIADO_GRANDE);
}

/**
 * Regla de validación: la API GraphQL es de sólo lectura. Una `mutation` o una
 * `subscription` se rechaza antes de ejecutar nada (sin esto, graphql-js la
 * rechaza recién al ejecutar y Apollo la informa como error interno).
 */
export const soloConsultas: ValidationRule = (context: ValidationContext) => ({
  OperationDefinition(operacion: ASTNode) {
    if (operacion.kind !== Kind.OPERATION_DEFINITION) return;
    if (operacion.operation === OperationTypeNode.QUERY) return;
    context.reportError(
      rechazo(
        'La API GraphQL es de sólo lectura: sólo acepta consultas (query)',
        CODIGO_OPERACION_NO_PERMITIDA,
      ),
    );
  },
});

/**
 * Regla de validación: rechaza la operación que anida más de `maximo` niveles.
 * Los campos de introspección (`__schema`, `__type`) no cuentan: sólo se
 * permiten fuera de producción y su consulta es profunda por naturaleza.
 */
export function limiteDeProfundidad(maximo: number): ValidationRule {
  return (context: ValidationContext) => {
    const fragmentos = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragmentos.set(def.name.value, def);
      }
    }

    const profundidad = (
      seleccion: SelectionSetNode | undefined,
      nivel: number,
      visitados: ReadonlySet<string>,
    ): number => {
      if (!seleccion) return nivel - 1;
      let maxima = nivel - 1;
      for (const nodo of seleccion.selections) {
        if (nodo.kind === Kind.FIELD) {
          if (nodo.name.value.startsWith('__')) continue;
          maxima = Math.max(
            maxima,
            profundidad(nodo.selectionSet, nivel + 1, visitados),
          );
        } else if (nodo.kind === Kind.INLINE_FRAGMENT) {
          maxima = Math.max(
            maxima,
            profundidad(nodo.selectionSet, nivel, visitados),
          );
        } else {
          const nombre = nodo.name.value;
          const fragmento = fragmentos.get(nombre);
          // Un fragmento que no existe o que se incluye a sí mismo lo rechazan
          // las reglas estándar de GraphQL; acá sólo se evita el ciclo.
          if (!fragmento || visitados.has(nombre)) continue;
          maxima = Math.max(
            maxima,
            profundidad(
              fragmento.selectionSet,
              nivel,
              new Set([...visitados, nombre]),
            ),
          );
        }
      }
      return maxima;
    };

    return {
      OperationDefinition(operacion: ASTNode) {
        if (operacion.kind !== Kind.OPERATION_DEFINITION) return;
        const alcanzada = profundidad(operacion.selectionSet, 1, new Set());
        if (alcanzada > maximo) {
          context.reportError(
            demasiadoGrande(
              `La consulta anida ${alcanzada} niveles y el máximo es ${maximo}`,
            ),
          );
        }
      },
    };
  };
}

/** Regla de validación: rechaza la operación más compleja que `maximo`. */
export function limiteDeComplejidad(maximo: number): ValidationRule {
  return createComplexityRule({
    maximumComplexity: maximo,
    estimators: [
      fieldExtensionsEstimator(),
      simpleEstimator({ defaultComplexity: 1 }),
    ],
    createError: (max, actual) =>
      demasiadoGrande(
        `La consulta es demasiado compleja (${actual}) y el máximo es ${max}: pedí menos informes o menos campos por consulta`,
      ),
  });
}
