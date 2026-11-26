import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import type { ContextoGraphql } from '../common/contexto/request-del-contexto';
import { formatearErrorGraphql } from './formatear-error-graphql';
import {
  COMPLEJIDAD_MAXIMA,
  limiteDeComplejidad,
  limiteDeProfundidad,
  PROFUNDIDAD_MAXIMA,
  soloConsultas,
} from './limites-de-consulta';

/** Ruta de la API GraphQL, debajo del prefijo global: `/api/graphql`. */
export const RUTA_GRAPHQL = '/graphql';

/**
 * El explorador (GraphiQL en `GET /api/graphql`) y la introspección del
 * esquema sólo con `NODE_ENV` `development` o `test`, el mismo criterio que la
 * documentación de Swagger sin credenciales: con cualquier otro valor, o sin
 * él, quedan apagados (falla cerrado).
 */
export function exploradorHabilitado(env: { NODE_ENV?: string }): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

/**
 * Configuración de la API GraphQL (Apollo sobre Express, esquema code-first
 * armado en memoria a partir de los resolvers).
 *
 * - Sólo consultas: los resolvers no declaran `mutation` ni `subscription`, y
 *   una operación que no sea `query` se rechaza al validar (`soloConsultas`).
 * - Seguridad: la de los guards globales (token, rol, permiso, modo soporte,
 *   distribuidora y límite de pedidos), que leen la request del contexto.
 * - Límites: profundidad y complejidad por consulta; sin lotes de operaciones
 *   (`allowBatchedHttpRequests` queda en false, el default de Apollo).
 * - CSRF: la prevención de Apollo exige un `Content-Type: application/json` o
 *   un encabezado propio (`apollo-require-preflight`), así que una consulta
 *   desde otro sitio pasa por el preflight y ahí la frena el CORS de la API,
 *   que sólo acepta los orígenes de `CORS_ORIGINS`.
 */
export function opcionesDeGraphql(env: {
  NODE_ENV?: string;
}): ApolloDriverConfig {
  const explorador = exploradorHabilitado(env);
  return {
    driver: ApolloDriver,
    path: RUTA_GRAPHQL,
    useGlobalPrefix: true,
    autoSchemaFile: true,
    sortSchema: true,
    introspection: explorador,
    graphiql: explorador,
    playground: false,
    csrfPrevention: true,
    includeStacktraceInErrorResponses: false,
    autoTransformHttpErrors: false,
    formatError: formatearErrorGraphql,
    validationRules: [
      soloConsultas,
      limiteDeProfundidad(PROFUNDIDAD_MAXIMA),
      limiteDeComplejidad(COMPLEJIDAD_MAXIMA),
    ],
    context: ({ req, res }: ContextoGraphql): ContextoGraphql => ({ req, res }),
  };
}
