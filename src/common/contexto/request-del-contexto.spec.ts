import type { ExecutionContext } from '@nestjs/common';
import {
  esConsultaGraphql,
  esGraphql,
  requestDelContexto,
  requestYRespuestaDelContexto,
} from './request-del-contexto';

const req = { headers: {} };
const res = { header: jest.fn() };

const http = {
  getType: () => 'http',
  switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
} as unknown as ExecutionContext;

/** Un resolver recibe (root, args, contexto, info). */
const graphql = (operacion: string) =>
  ({
    getType: () => 'graphql',
    getArgs: () => [
      undefined,
      {},
      { req, res },
      { operation: { operation: operacion } },
    ],
    getClass: () => Object,
    getHandler: () => () => undefined,
  }) as unknown as ExecutionContext;

describe('requestDelContexto', () => {
  it('REST: la request de Express', () => {
    expect(requestDelContexto(http)).toBe(req);
    expect(requestYRespuestaDelContexto(http)).toEqual({ req, res });
    expect(esGraphql(http)).toBe(false);
    expect(esConsultaGraphql(http)).toBe(false);
  });

  it('GraphQL: la request del contexto del resolver', () => {
    expect(requestDelContexto(graphql('query'))).toBe(req);
    expect(requestYRespuestaDelContexto(graphql('query'))).toEqual({
      req,
      res,
    });
    expect(esGraphql(graphql('query'))).toBe(true);
  });

  it('sólo una query es lectura', () => {
    expect(esConsultaGraphql(graphql('query'))).toBe(true);
    expect(esConsultaGraphql(graphql('mutation'))).toBe(false);
    expect(esConsultaGraphql(graphql('subscription'))).toBe(false);
  });
});
