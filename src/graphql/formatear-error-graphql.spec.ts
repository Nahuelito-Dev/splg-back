import { BadRequestException, HttpException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { conCodigo } from '../common/errors/con-codigo';
import {
  formatearErrorGraphql,
  MENSAJE_ERROR_INTERNO,
} from './formatear-error-graphql';

const formateado = {
  message: 'lo que armó Apollo',
  path: ['salesSummary'],
  extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at x'] },
};

/** Como llega una falla de resolver: un GraphQLError con la original adentro. */
const deResolver = (original: Error) =>
  new GraphQLError(original.message, {
    path: ['salesSummary'],
    originalError: original,
  });

describe('formatearErrorGraphql', () => {
  it('una excepción con code: su texto, su code y su estado', () => {
    const r = formatearErrorGraphql(
      formateado,
      deResolver(
        conCodigo(BadRequestException, 400, 'Falta algo', 'MISSING_X'),
      ),
    );
    expect(r).toEqual({
      message: 'Falta algo',
      path: ['salesSummary'],
      locations: undefined,
      extensions: { code: 'MISSING_X', statusCode: 400 },
    });
  });

  it('sin code: el nombre del estado; varios mensajes, unidos', () => {
    const r = formatearErrorGraphql(
      formateado,
      deResolver(new BadRequestException(['uno', 'dos'])),
    );
    expect(r.message).toBe('uno. dos');
    expect(r.extensions).toEqual({ code: 'BAD_REQUEST', statusCode: 400 });
  });

  it('un cuerpo de texto', () => {
    const r = formatearErrorGraphql(
      formateado,
      deResolver(new HttpException('Demasiados', 429)),
    );
    expect(r.message).toBe('Demasiados');
    expect(r.extensions).toEqual({
      code: 'TOO_MANY_REQUESTS',
      statusCode: 429,
    });
  });

  it('un error que no es de Nest ni de GraphQL: genérico y sin detalle', () => {
    const r = formatearErrorGraphql(formateado, new Error('secreto SQL'));
    expect(r.message).toBe(MENSAJE_ERROR_INTERNO);
    expect(r.extensions).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      statusCode: 500,
    });
  });

  it('un error de GraphQL: el de Apollo sin el stack, con el estado del pedido', () => {
    const r = formatearErrorGraphql(
      {
        message: 'Cannot query field "x"',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED', stacktrace: ['a'] },
      },
      new GraphQLError('Cannot query field "x"'),
    );
    expect(r).toEqual({
      message: 'Cannot query field "x"',
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED', statusCode: 400 },
    });
  });

  it('un error de GraphQL sin estado conocido queda sin statusCode', () => {
    const r = formatearErrorGraphql(
      { message: 'raro', extensions: { code: 'OTRO' } },
      new GraphQLError('raro'),
    );
    expect(r.extensions).toEqual({ code: 'OTRO' });
  });
});
