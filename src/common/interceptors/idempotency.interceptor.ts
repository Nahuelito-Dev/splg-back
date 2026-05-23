import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, firstValueFrom, from, of } from 'rxjs';
import { RedisService } from '../../redis/redis.service';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CACHE_TTL_SEC = 60 * 60 * 24; // 24h — alineado con doc del header en RFC
const LOCK_TTL_MS = 30_000; // 30s — debería sobrar para cualquier mutation
const HEADER = 'idempotency-key';

interface CachedResponse {
  status: number;
  body: unknown;
  cachedAt: string;
}

/**
 * Interceptor de idempotencia basado en Redis.
 *
 * Activado por @Idempotent() en el handler. Lee `Idempotency-Key` del
 * header (UUID v4). Si está presente, asegura que el handler se ejecute
 * exactamente una vez aunque el cliente reintente por timeouts o errores
 * de red transparentes.
 *
 * Algoritmo (anti race condition):
 *
 *   GET cache → si hit: return cached
 *   ACQUIRE lock → si falló: 409 (otra request con misma key en curso)
 *   GET cache AGAIN (double-check) → si hit ahora: return cached
 *   EXECUTE handler
 *   SET cache (solo si 2xx)
 *   RELEASE lock
 *
 * Solo se cachean respuestas 2xx. Si el handler lanza, no se cachea
 * y el cliente puede reintentar con la misma key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('IdempotencyInterceptor');

  constructor(
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!isIdempotent) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const rawKey: string | undefined = request.headers[HEADER];

    // Sin header → backwards compat: ejecutar normalmente
    if (!rawKey) {
      return next.handle();
    }

    if (!UUID_REGEX.test(rawKey)) {
      throw new BadRequestException(
        'Idempotency-Key debe ser un UUID v4 válido',
      );
    }

    const cacheKey = `idempotency:${rawKey}`;
    const lockKey = `idempotency-lock:${rawKey}`;

    // Fast path: respuesta ya cacheada
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      return of(this.parseCached(cached));
    }

    // Adquirir lock distribuido para serializar requests con misma key
    const lock = await this.redisService.acquireLock(lockKey, LOCK_TTL_MS);
    if (!lock) {
      throw new ConflictException(
        'Request en curso con la misma Idempotency-Key. Reintente más tarde.',
      );
    }

    try {
      // Double-check: entre el GET y el lock alguien pudo haber terminado
      const cachedAfterLock = await this.redisService.get(cacheKey);
      if (cachedAfterLock) {
        return of(this.parseCached(cachedAfterLock));
      }

      // Ejecutar el handler. Si lanza, se propaga sin cachear.
      const response = await firstValueFrom(next.handle());

      // Persistir respuesta exitosa. Errores no llegan acá (throw arriba).
      const payload: CachedResponse = {
        status: 200, // si llegó acá, fue éxito
        body: response,
        cachedAt: new Date().toISOString(),
      };
      await this.redisService.setex(
        cacheKey,
        CACHE_TTL_SEC,
        JSON.stringify(payload),
      );

      this.logger.debug(`Idempotency cached: ${rawKey}`);
      return of(response);
    } finally {
      // Liberar lock; si ya expiró por TTL, ignorar
      await lock.release().catch(() => undefined);
    }
  }

  private parseCached(raw: string): unknown {
    try {
      const parsed: CachedResponse = JSON.parse(raw);
      this.logger.debug(`Idempotency hit (cachedAt=${parsed.cachedAt})`);
      return parsed.body;
    } catch {
      // Cache corrupto: lo borramos y dejamos que el siguiente request lo regenere
      this.logger.warn('Cache de idempotencia corrupto, ignorando');
      return null;
    }
  }
}
