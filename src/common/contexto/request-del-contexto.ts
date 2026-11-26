import type { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext, type GqlContextType } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { OperationTypeNode, type GraphQLResolveInfo } from 'graphql';

/** Lo que cada resolver recibe como contexto (lo arma `GraphqlApiModule`). */
export interface ContextoGraphql {
  req: Request;
  res: Response;
}

/** true si el handler es un resolver de GraphQL (no un controlador REST). */
export function esGraphql(ctx: ExecutionContext): boolean {
  return ctx.getType<GqlContextType>() === 'graphql';
}

/**
 * La request de Express detrás del handler, sea un controlador REST o un
 * resolver de GraphQL (que la recibe en su contexto). Así los guards y los
 * decoradores de identidad y de distribuidora son los mismos en las dos APIs:
 * `AuthGuard` deja `user` y `distributorId` en la misma request que después
 * leen `@CurrentUser()` y `@CurrentDistributor()`.
 */
export function requestDelContexto(ctx: ExecutionContext): Request {
  if (esGraphql(ctx)) {
    return GqlExecutionContext.create(ctx).getContext<ContextoGraphql>().req;
  }
  return ctx.switchToHttp().getRequest<Request>();
}

/** La request y la respuesta de Express del handler (REST o GraphQL). */
export function requestYRespuestaDelContexto(ctx: ExecutionContext): {
  req: Request;
  res: Response;
} {
  if (esGraphql(ctx)) {
    return GqlExecutionContext.create(ctx).getContext<ContextoGraphql>();
  }
  const http = ctx.switchToHttp();
  return { req: http.getRequest<Request>(), res: http.getResponse<Response>() };
}

/**
 * true si el handler es parte de una operación GraphQL de sólo lectura
 * (`query`). La API GraphQL no tiene `mutation` ni `subscription`, pero el
 * modo soporte no lo da por sentado: decide por la operación, no por el
 * método HTTP (que en GraphQL es casi siempre `POST`).
 */
export function esConsultaGraphql(ctx: ExecutionContext): boolean {
  if (!esGraphql(ctx)) return false;
  const info = GqlExecutionContext.create(ctx).getInfo<
    GraphQLResolveInfo | undefined
  >();
  return info?.operation.operation === OperationTypeNode.QUERY;
}
