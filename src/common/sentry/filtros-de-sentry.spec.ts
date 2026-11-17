import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorEvent, Log, NodeOptions } from '@sentry/nestjs';
import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../errors/domain.error';
import { FILTRADO } from './datos-sensibles';
import {
  antesDeEnviarError,
  antesDeEnviarLog,
  antesDeEnviarSpan,
  limpiarEvento,
} from './filtros-de-sentry';

class PedidoEnOtroEstado extends ConflictDomainError {
  constructor() {
    super('El pedido ya no admite el cambio');
  }
}
class DatoInvalido extends BadRequestDomainError {
  constructor() {
    super('Dato inválido');
  }
}
class NoExiste extends NotFoundDomainError {
  constructor() {
    super('No existe');
  }
}

type SpanDeSentry = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

describe('filtros de Sentry', () => {
  describe('beforeSend', () => {
    it('nunca manda el cuerpo ni la consulta; saca encabezados, cookies y usuario con datos personales', () => {
      const evento: ErrorEvent = {
        type: undefined,
        message: 'falló para ana@example.com',
        request: {
          url: '/api/v1/customers?email=ana%40example.com&page=1',
          method: 'POST',
          headers: {
            authorization: 'Bearer eyJa.eyJb.c',
            cookie: 'sesion=1',
            'x-support-session': 'sesion-123',
            'x-request-id': 'req-1',
          },
          cookies: { sesion: '1' },
          env: { REMOTE_ADDR: '1.2.3.4' },
          data: {
            password: 'secreta',
            dni: '30111222',
            cuit: '20-30111222-3',
            phone: '3764000000',
            telefono: '3764000000',
            email: 'ana@example.com',
            address: 'Calle 1',
            direccion: 'Calle 1',
            quantity: 2,
          },
          query_string: 'token=abc&page=1',
        },
        user: {
          id: 'u-1',
          email: 'ana@example.com',
          username: 'Ana',
          ip_address: '1.2.3.4',
        },
        exception: {
          values: [{ type: 'Error', value: 'no existe ana@example.com' }],
        },
        extra: { accessKeyId: 'AKIA', motivo: 'x' },
        contexts: { mp: { access_token: 'APP_USR-1' } },
        tags: { request_id: 'req-1' },
        breadcrumbs: [
          { message: 'aviso a ana@example.com', data: { token: 't' } },
          { category: 'http' },
        ],
      };

      const limpio = antesDeEnviarError(evento) as ErrorEvent;

      expect(limpio.request).toEqual({
        url: '/api/v1/customers',
        method: 'POST',
        headers: {
          authorization: FILTRADO,
          cookie: FILTRADO,
          'x-support-session': FILTRADO,
          'x-request-id': 'req-1',
        },
      });
      expect(limpio.user).toEqual({ id: 'u-1' });
      expect(limpio.message).toBe(`falló para ${FILTRADO}`);
      expect(limpio.exception?.values?.[0].value).toBe(`no existe ${FILTRADO}`);
      expect(limpio.extra).toEqual({ accessKeyId: FILTRADO, motivo: 'x' });
      expect(limpio.contexts).toEqual({ mp: { access_token: FILTRADO } });
      expect(limpio.tags).toEqual({ request_id: 'req-1' });
      expect(limpio.breadcrumbs).toEqual([
        { message: `aviso a ${FILTRADO}`, data: { token: FILTRADO } },
        { category: 'http' },
      ]);
      expect(evento.request?.headers?.authorization).toBe('Bearer eyJa.eyJb.c');
    });

    it('un usuario sin id no sale, y un evento sin request queda igual', () => {
      expect(limpiarEvento({ user: { email: 'a@b.co' } }).user).toBeUndefined();
      expect(limpiarEvento({ level: 'error' })).toEqual({ level: 'error' });
    });

    it('cualquier cuerpo (texto, multipart, chat, CBU) se descarta entero', () => {
      const limpio = limpiarEvento({
        logentry: { message: 'para a@b.co', params: [] },
        request: {
          url: '/api/v2/chat/messages',
          query_string: { email: 'a@b.co', page: '1' },
          data: {
            body: 'mi CBU es 0000003100010000000001',
            fullName: 'Ana Pérez',
            taxId: '20301112223',
            lat: -27.36,
          },
        },
      });
      expect(limpio.logentry?.message).toBe(`para ${FILTRADO}`);
      expect(limpio.request).toEqual({ url: '/api/v2/chat/messages' });
    });

    it('tapa los valores del detail de Postgres en la excepción', () => {
      const limpio = antesDeEnviarError({
        type: undefined,
        exception: {
          values: [
            {
              type: 'QueryFailedError',
              value:
                'Key (distributor_id, tax_id)=(d-1, 20-30111222-3) already exists.',
            },
          ],
        },
      });
      expect(limpio?.exception?.values?.[0].value).toBe(
        `Key (distributor_id, tax_id)=(${FILTRADO}) already exists.`,
      );
    });

    it.each([
      ['un BadRequestException', new BadRequestException()],
      ['un NotFoundException', new NotFoundException()],
      ['un ConflictException', new ConflictException()],
      ['un ConflictDomainError', new PedidoEnOtroEstado()],
      ['un BadRequestDomainError', new DatoInvalido()],
      ['un NotFoundDomainError', new NoExiste()],
    ])(
      '%s (un 4xx en HTTP, p. ej. tirado en un @OnEvent) no sale',
      (_n, error) => {
        expect(
          antesDeEnviarError({ type: undefined }, { originalException: error }),
        ).toBeNull();
      },
    );

    it.each([
      ['un Error', new Error('x')],
      ['un 500', new InternalServerErrorException()],
      ['un texto', 'algo'],
      [
        'algo con getStatus que no es número',
        { getStatus: () => 'x', getResponse: () => ({}) },
      ],
    ])('%s sí sale', (_n, error) => {
      expect(
        antesDeEnviarError({ type: undefined }, { originalException: error }),
      ).not.toBeNull();
    });
  });

  describe('beforeSendLog', () => {
    it('sólo pasa error (y fatal): warn no, que serían los 4xx de cada request', () => {
      const log = (level: Log['level']): Log => ({ level, message: 'm' });
      expect(antesDeEnviarLog(log('info'))).toBeNull();
      expect(antesDeEnviarLog(log('debug'))).toBeNull();
      expect(antesDeEnviarLog(log('trace'))).toBeNull();
      expect(antesDeEnviarLog(log('warn'))).toBeNull();
      expect(antesDeEnviarLog(log('error'))).not.toBeNull();
      expect(antesDeEnviarLog(log('fatal'))).not.toBeNull();
    });

    it('tapa el detail de Postgres y la consulta de las URLs', () => {
      expect(
        antesDeEnviarLog({
          level: 'error',
          message:
            '[r1] POST /api/v1/suppliers?cuit=20301112223 500 — duplicate (Key (tax_id)=(20-30111222-3) already exists.)',
          attributes: { 'url.full': 'https://x.com/a?dni=1' },
        }),
      ).toEqual({
        level: 'error',
        message: `[r1] POST /api/v1/suppliers 500 — duplicate (Key (tax_id)=(${FILTRADO}) already exists.)`,
        attributes: { 'url.full': 'https://x.com/a' },
      });
    });

    it('tapa datos personales del mensaje y de los atributos', () => {
      expect(
        antesDeEnviarLog({
          level: 'error',
          message: 'no se pudo avisar a ana@example.com',
          attributes: { context: 'Mail', email: 'ana@example.com' },
        }),
      ).toEqual({
        level: 'error',
        message: `no se pudo avisar a ${FILTRADO}`,
        attributes: { context: 'Mail', email: FILTRADO },
      });
      expect(
        antesDeEnviarLog({ level: 'error', message: 'sin atributos' }),
      ).toEqual({
        level: 'error',
        message: 'sin atributos',
        attributes: undefined,
      });
    });
  });

  describe('beforeSendSpan', () => {
    it('tapa los atributos sensibles de la traza', () => {
      const span: SpanDeSentry = {
        trace_id: 't',
        span_id: 's',
        name: 'GET /api/v1/users',
        start_timestamp: 1,
        status: 'ok',
        is_segment: true,
        attributes: {
          'http.request.header.authorization': 'Bearer x',
          'http.request.method': 'GET',
          'url.query': 'email=a@b.co',
        },
      };
      expect(antesDeEnviarSpan(span).attributes).toEqual({
        'http.request.header.authorization': FILTRADO,
        'http.request.method': 'GET',
        'url.query': FILTRADO,
      });
    });
  });
});
