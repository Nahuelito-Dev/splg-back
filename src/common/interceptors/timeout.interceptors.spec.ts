import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NEVER, lastValueFrom, of, throwError, TimeoutError } from 'rxjs';
import { MENSAJE_TIMEOUT, TimeoutInterceptor } from './timeout.interceptors';

describe('TimeoutInterceptor', () => {
  const ctx = {} as ExecutionContext;
  const interceptor = new TimeoutInterceptor();
  const con = (handler: CallHandler<unknown>) =>
    lastValueFrom(interceptor.intercept(ctx, handler));

  it('deja pasar la respuesta normal', async () => {
    await expect(con({ handle: () => of('ok') })).resolves.toBe('ok');
  });

  it('un TimeoutError sale 503 con mensaje claro, no 500', async () => {
    const handler = {
      handle: () => throwError(() => new TimeoutError()),
    };
    await expect(con(handler)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(con(handler)).rejects.toThrow(MENSAJE_TIMEOUT);
  });

  it('otros errores pasan sin tocar', async () => {
    const error = new BadRequestException('mal');
    await expect(con({ handle: () => throwError(() => error) })).rejects.toBe(
      error,
    );
  });

  it('corta una respuesta que supera el tiempo máximo', async () => {
    jest.useFakeTimers();
    try {
      const error = con({ handle: () => NEVER }).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(120_001);
      expect(await error).toBeInstanceOf(ServiceUnavailableException);
    } finally {
      jest.useRealTimers();
    }
  });
});
