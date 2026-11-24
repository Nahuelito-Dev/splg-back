import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { Request } from 'express';
import {
  esGraphql,
  requestYRespuestaDelContexto,
} from '../contexto/request-del-contexto';

/**
 * Rutas de acceso: las únicas donde además del cupo por IP se cuenta un cupo
 * por cuenta. No incluye los registros a propósito (ver `esRutaDeAcceso`).
 */
const RUTAS_DE_ACCESO = ['/auth/login', '/auth/login/dashboard'];

/** Nombre del throttler que cuenta los intentos de acceso por cuenta. */
export const THROTTLER_CUENTA = 'cuenta';

/** Nombre del throttler que cuenta las subidas de archivos por usuario. */
export const THROTTLER_SUBIDAS = 'subidas';

/**
 * true si la petición sube un archivo (multipart). Procesar una imagen cuesta
 * memoria y CPU: tienen un cupo propio, más bajo que el general y compartido
 * entre todas las rutas de subida de la misma sesión.
 */
export function esRutaDeSubida(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return false;
  const req = context.switchToHttp().getRequest<Request>();
  return (
    ['POST', 'PUT', 'PATCH'].includes(req.method) &&
    Boolean(req.headers?.['content-type']?.startsWith('multipart/form-data'))
  );
}

/** true si la petición es un intento de acceso (no un registro). */
export function esRutaDeAcceso(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return false;
  const req = context.switchToHttp().getRequest<Request>();
  const rutaDeclarada = (req.route as { path?: unknown } | undefined)?.path;
  const ruta =
    typeof rutaDeclarada === 'string' ? rutaDeclarada : (req.path ?? req.url);
  return RUTAS_DE_ACCESO.some((r) => ruta.endsWith(r));
}

/**
 * `ThrottlerGuard` es GLOBAL (APP_GUARD) → corre para TODOS los execution
 * contexts, no solo HTTP: esta app también tiene gateways de Socket.io
 * (`drivers`, `customers`, `admin`) con `@SubscribeMessage`. El rate limiting
 * de `@nestjs/throttler` está pensado para requests HTTP (usa
 * `context.switchToHttp()` para leer IP/headers); en un contexto `ws` esos
 * campos no existen y la app se rompe. Igual que HTTP: el rate limiting de
 * WS (si hiciera falta) se maneja en la capa de socket, no acá.
 *
 * Se salta (no throttlea, deja pasar) cualquier context que NO sea HTTP ni
 * GraphQL. Un resolver de GraphQL cuenta como una petición más del mismo
 * cupo: lee la request y la respuesta de su contexto (`getRequestResponse`).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' && !esGraphql(context)) {
      return true;
    }
    return super.shouldSkip(context);
  }

  protected getRequestResponse(context: ExecutionContext): {
    req: Record<string, unknown>;
    res: Record<string, unknown>;
  } {
    const { req, res } = requestYRespuestaDelContexto(context);
    return {
      req: req as unknown as Record<string, unknown>,
      res: res as unknown as Record<string, unknown>,
    };
  }

  /**
   * De quién se cuentan las peticiones.
   *
   * Por defecto `@nestjs/throttler` cuenta por `req.ip`. Detrás de un proxy eso
   * es la IP del proxy, la misma para todo el mundo: **todos los usuarios
   * comparten un único cupo**. Medido: 130 peticiones desde 130 IP distintas,
   * las primeras 100 pasan y el resto recibe 429.
   *
   * Acá se cuenta por **sesión** cuando la hay: dos peticiones con el mismo
   * token son del mismo usuario, así que cada uno tiene su propio cupo y el
   * límite deja de depender de cuánta gente esté conectada.
   *
   * El token no se verifica —eso es trabajo del `AuthGuard`, que corre
   * después—: sólo se lo usa como identificador estable, y se guarda su hash
   * en vez del token para no dejarlo escrito en Redis.
   *
   * Sin sesión (login, registro, catálogo público) se cae a la IP, que es lo
   * correcto: ahí todavía no hay usuario a quien atribuirle el consumo. En el
   * login eso NO alcanza por sí solo, y por eso existe el segundo cupo: ver
   * `generateKey`.
   */
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(this.trackerDe(req as unknown as Request));
  }

  private trackerDe(req: Request): string {
    const autorizacion = req.headers?.authorization;

    if (autorizacion?.startsWith('Bearer ')) {
      const token = autorizacion.slice(7);
      if (token) {
        return `sesion:${huella(token)}`;
      }
    }

    return `ip:${req.ip ?? req.socket?.remoteAddress ?? 'desconocida'}`;
  }

  /**
   * El login se cuenta en DOS dimensiones a la vez, y hacen falta las dos:
   *
   * - **Por IP** (throttler `default`, el de siempre): frena a un host que
   *   pruebe muchas cuentas distintas. Sin esto, variar el email deja el
   *   ataque sin techo.
   * - **Por cuenta** (throttler `cuenta`, sólo en las rutas de acceso): frena
   *   que alguien pruebe claves contra UNA cuenta. Las contraseñas no son
   *   nuestras —las valida Firebase, la base no tiene columna de contraseña—,
   *   pero este endpoint es la puerta por la que se llega a Firebase: sin
   *   límite, se lo puede usar para adivinar una clave ajena. Y como los
   *   límites de Firebase son por proyecto, un ataque sostenido terminaría
   *   afectando el acceso de todos.
   *
   * La segunda dimensión existe porque contar el acceso sólo por IP rompe en
   * producción: los celulares salen por el CGNAT del operador y cientos de
   * clientes comparten una misma IP pública, así que entre ellos se agotarían
   * un cupo estricto y se bloquearían el acceso sin haber hecho nada. Con los
   * dos cupos, cada cuenta tiene el suyo y la IP conserva un techo amplio.
   *
   * Se cambia la clave y no el tracker porque `getTracker` lo comparten todos
   * los throttlers: devolver la cuenta desde ahí dejaría al login fuera del
   * cupo por IP, que es justamente el que lo protege.
   */
  protected generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    if (name === THROTTLER_SUBIDAS) {
      // Sin la ruta en la clave: el cupo es por sesión, no por endpoint.
      return createHash('sha256')
        .update(`${THROTTLER_SUBIDAS}-${suffix}`)
        .digest('hex');
    }
    if (name === THROTTLER_CUENTA) {
      const cuenta = this.cuentaDelAcceso(context);
      // Sin email (cuerpo inválido: lo rechaza el ValidationPipe después) se
      // deja el sufijo por IP, para no darle un cupo libre a cada petición mal
      // formada.
      if (cuenta) {
        return super.generateKey(context, `cuenta:${huella(cuenta)}`, name);
      }
    }
    return super.generateKey(context, suffix, name);
  }

  /** Email normalizado del intento de acceso, o `null` si no lo trae. */
  private cuentaDelAcceso(context: ExecutionContext): string | null {
    const cuerpo: unknown = context.switchToHttp().getRequest<Request>().body;
    const email =
      typeof cuerpo === 'object' && cuerpo !== null && 'email' in cuerpo
        ? cuerpo.email
        : undefined;
    return typeof email === 'string' && email.trim()
      ? email.trim().toLowerCase()
      : null;
  }
}

/** Hash estable: el identificador no se guarda en claro en Redis. */
function huella(valor: string): string {
  return createHash('sha256').update(valor).digest('hex').slice(0, 32);
}
