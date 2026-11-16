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
import {
  IDEMPOTENT_DESPUES_DE_MULTER_KEY,
  IDEMPOTENT_KEY,
} from '../decorators/idempotent.decorator';
import type { Request } from 'express';
import { createHash } from 'crypto';
import { conRespuestaVigilada } from './respuesta-incompleta';
import { CODIGOS_DE_ERROR, conCodigo } from '../errors/con-codigo';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CACHE_TTL_SEC = 60 * 60 * 24; // 24h — alineado con doc del header en RFC
/** Respuesta incompleta (falló la relectura tras confirmar): sólo cubre el reintento inmediato. */
const CACHE_TTL_INCOMPLETA_SEC = 5 * 60;
const LOCK_TTL_MS = 30_000; // vigencia inicial; se renueva mientras el handler corre
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
 *   ACQUIRE lock (se renueva solo mientras corre) → si falló: 409
 *   GET cache AGAIN (double-check) → si hit ahora: return cached
 *   EXECUTE handler
 *   SET cache (solo si 2xx)
 *   RELEASE lock
 *
 * El alcance de la clave es usuario + distribuidora + método + ruta + params.
 * Una entrada de cache corrupta se borra y la operación se ejecuta.
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

  /** `true` en la versión de método que corre después de multer. */
  protected readonly despuesDeMulter: boolean = false;

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
    // Las rutas multipart las atiende la versión que corre después de multer.
    if (
      !this.despuesDeMulter &&
      this.reflector.getAllAndOverride<boolean>(
        IDEMPOTENT_DESPUES_DE_MULTER_KEY,
        [context.getHandler(), context.getClass()],
      )
    ) {
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
      throw conCodigo(
        BadRequestException,
        400,
        'Idempotency-Key debe ser un UUID v4 válido',
        CODIGOS_DE_ERROR.IDEMPOTENCY_KEY_INVALID,
      );
    }

    // La clave del cliente sola no alcanza: la misma en otra ruta, otro método,
    // otro usuario u otra distribuidora es otra operación y no puede devolver
    // la respuesta ajena. La distribuidora es la que resolvió el AuthGuard
    // (un super admin que cambia de X-Distributor cambia de alcance).
    const req = request as Request & {
      user?: { user_id?: string };
      distributorId?: string | null;
    };
    const alcance = [
      req.user?.user_id ?? 'anon',
      req.distributorId ?? 'sin-distribuidora',
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

    // En un multipart el archivo no va en el body: entra en la huella para que
    // la misma clave con otro archivo sea otra operación (422).
    const archivo = (request as Request & { file?: { buffer?: Buffer } }).file;
    const cuerpo: unknown = request.body;
    const bodyHash = hashDeBody(
      archivo?.buffer
        ? {
            body: cuerpo,
            archivo: createHash('sha256').update(archivo.buffer).digest('hex'),
          }
        : cuerpo,
    );

    // Fast path: respuesta ya cacheada
    const hit = await this.leerCache(cacheKey, bodyHash);
    if (hit) {
      return of(hit.body);
    }

    // Lock distribuido para serializar requests con la misma key. Se renueva
    // solo mientras el handler corre: no puede vencer antes que la operación
    // (el statement_timeout de la base y el timeout HTTP son mayores que su
    // vigencia inicial).
    const resultado = await this.redisService.withLock(
      lockKey,
      LOCK_TTL_MS,
      async (): Promise<{ body: unknown }> => {
        // Double-check: entre el GET y el lock alguien pudo haber terminado
        const despuesDelLock = await this.leerCache(cacheKey, bodyHash);
        if (despuesDelLock) return despuesDelLock;

        // Ejecutar el handler. Si lanza, se propaga sin cachear.
        const { valor: response, incompleta } =
          await conRespuestaVigilada<unknown>(() =>
            firstValueFrom(next.handle()),
          );

        // Persistir respuesta exitosa. Errores no llegan acá (throw arriba).
        const payload: CachedResponse = {
          status: 200, // si llegó acá, fue éxito
          body: response,
          bodyHash,
          cachedAt: new Date().toISOString(),
        };
        await this.redisService.setex(
          cacheKey,
          incompleta ? CACHE_TTL_INCOMPLETA_SEC : CACHE_TTL_SEC,
          JSON.stringify(payload),
        );
        this.logger.debug(`Idempotency cached: ${rawKey}`);
        return { body: response };
      },
    );
    if (!resultado.obtenido) {
      throw conCodigo(
        ConflictException,
        409,
        'Hay otra solicitud en curso con la misma clave de idempotencia: reintentá en unos segundos.',
        CODIGOS_DE_ERROR.IDEMPOTENCY_IN_PROGRESS,
      );
    }
    return of(resultado.valor.body);
  }

  /**
   * La respuesta guardada para esta clave, o null si no hay (o estaba corrupta:
   * se borra y la operación se ejecuta, en vez de devolver un 2xx vacío).
   */
  private async leerCache(
    cacheKey: string,
    bodyHash: string,
  ): Promise<{ body: unknown } | null> {
    const raw = await this.redisService.get(cacheKey);
    if (!raw) return null;
    let parsed: CachedResponse;
    try {
      parsed = JSON.parse(raw) as CachedResponse;
    } catch {
      this.logger.warn(
        'Cache de idempotencia corrupto: se descarta y se ejecuta',
      );
      await this.redisService.del(cacheKey);
      return null;
    }
    // Entradas viejas sin hash: se aceptan como antes.
    if (parsed.bodyHash && parsed.bodyHash !== bodyHash) {
      throw conCodigo(
        UnprocessableEntityException,
        422,
        MENSAJE_CLAVE_OTROS_DATOS,
        CODIGOS_DE_ERROR.IDEMPOTENCY_KEY_REUSED,
      );
    }
    this.logger.debug(`Idempotency hit (cachedAt=${parsed.cachedAt})`);
    return { body: parsed.body };
  }
}

/**
 * La misma idempotencia, declarada en el método DESPUÉS del interceptor de
 * multer: ahí `request.file` y `request.body` ya están, y la huella incluye el
 * archivo (la misma clave con otro archivo es 422).
 */
@Injectable()
export class IdempotencyDespuesDeMulterInterceptor extends IdempotencyInterceptor {
  protected override readonly despuesDeMulter: boolean = true;
}
