import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, firstValueFrom, of } from 'rxjs';
import { RedisService } from '../../redis/redis.service';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import type { Request } from 'express';
import { createHash } from 'crypto';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CACHE_TTL_SEC = 60 * 60 * 24; // 24h — alineado con doc del header en RFC
const LOCK_TTL_MS = 30_000; // 30s — debería sobrar para cualquier mutation
const HEADER = 'idempotency-key';

interface CachedResponse {
  status: number;
  body: unknown;
  /** Huella del body de la request que produjo la respuesta. */
  bodyHash?: string;
  cachedAt: string;
}

export const MENSAJE_CLAVE_OTROS_DATOS =
  'Esa clave de idempotencia ya se usó con otros datos. Revisá si la operación anterior se registró antes de reintentar.';

/** JSON con las claves de los objetos ordenadas, para que el orden no cambie el hash. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) {
    return `[${valor.map((v) => canonico(v)).join(',')}]`;
  }
  if (valor && typeof valor === 'object') {
    const o = valor as Record<string, unknown>;
    const campos = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`);
    return `{${campos.join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}

export function hashDeBody(body: unknown): string {
  return createHash('sha256')
    .update(canonico(body ?? {}))
    .digest('hex');
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
 * La respuesta guardada lleva el hash del body. La misma clave con otro body
 * es 422: no se devuelve la respuesta de una operación distinta.
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

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[HEADER];
    const rawKey = typeof header === 'string' ? header : undefined;

    // Sin header → backwards compat: ejecutar normalmente
    if (!rawKey) {
      return next.handle();
    }

    if (!UUID_REGEX.test(rawKey)) {
      throw new BadRequestException(
        'Idempotency-Key debe ser un UUID v4 válido',
      );
    }

    // La clave del cliente sola no alcanza: la misma en otra ruta, otro método
    // u otro usuario es otra operación y no puede devolver la respuesta ajena.
    const user = (request as Request & { user?: { user_id?: string } }).user;
    const alcance = [
      user?.user_id ?? 'anon',
      request.method,
      (request.route as { path?: string } | undefined)?.path ?? request.path,
      JSON.stringify(request.params ?? {}),
    ].join('|');
    const huella = createHash('sha256')
      .update(alcance)
      .digest('hex')
      .slice(0, 24);
    const cacheKey = `idempotency:${huella}:${rawKey}`;
    const lockKey = `idempotency-lock:${huella}:${rawKey}`;

    const bodyHash = hashDeBody(request.body);

    // Fast path: respuesta ya cacheada
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      return of(this.parseCached(cached, bodyHash));
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
        return of(this.parseCached(cachedAfterLock, bodyHash));
      }

      // Ejecutar el handler. Si lanza, se propaga sin cachear.
      const response: unknown = await firstValueFrom(next.handle());

      // Persistir respuesta exitosa. Errores no llegan acá (throw arriba).
      const payload: CachedResponse = {
        status: 200, // si llegó acá, fue éxito
        body: response,
        bodyHash,
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

  private parseCached(raw: string, bodyHash: string): unknown {
    let parsed: CachedResponse;
    try {
      parsed = JSON.parse(raw) as CachedResponse;
    } catch {
      // Cache corrupto: lo borramos y dejamos que el siguiente request lo regenere
      this.logger.warn('Cache de idempotencia corrupto, ignorando');
      return null;
    }
    // Entradas viejas sin hash: se aceptan como antes.
    if (parsed.bodyHash && parsed.bodyHash !== bodyHash) {
      throw new UnprocessableEntityException(MENSAJE_CLAVE_OTROS_DATOS);
    }
    this.logger.debug(`Idempotency hit (cachedAt=${parsed.cachedAt})`);
    return parsed.body;
  }
}
