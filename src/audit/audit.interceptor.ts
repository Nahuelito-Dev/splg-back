import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { AuditService, NuevoAsiento } from './audit.service';
import { AuditResult } from './entities/audit-log.entity';
import { depurarCambios } from './depurar-cambios';
import {
  BadRequestDomainError,
  NotFoundDomainError,
} from '../common/errors/domain.error';
import { errorMessage } from '../common/errors/error-message';
import { traducirExcepcion } from '../common/validation/traducir-excepcion';
import { SOLO_LECTURA_KEY } from './solo-lectura.decorator';

const ESCRITURAS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CU-153: deja constancia de toda operación que modifica datos, exitosa o
 * rechazada. Corre después de los guards, así que conoce al usuario y su
 * distribuidora; lo que un guard rechaza (sin credencial, sin rol) no llegó
 * a ser una operación y no se registra. El asiento se guarda sin demorar la
 * respuesta.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    if (!ESCRITURAS.has(request.method)) return next.handle();
    const soloLectura = this.reflector.getAllAndOverride<boolean | undefined>(
      SOLO_LECTURA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (soloLectura) return next.handle();
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      tap(() => {
        void this.audit.registrar(
          this.asiento(request, AuditResult.SUCCESS, response.statusCode, null),
        );
      }),
      catchError((error: unknown) => {
        void this.audit.registrar(
          this.asiento(
            request,
            AuditResult.FAILURE,
            codigoDeError(error),
            motivoDelRechazo(error).slice(0, 1000),
          ),
        );
        return throwError(() => error);
      }),
    );
  }

  private asiento(
    request: Request,
    result: AuditResult,
    statusCode: number,
    errorMsg: string | null,
  ): NuevoAsiento {
    // La ruta como patrón (/api/users/email/:email): el dato concreto va en
    // resourceId y no queda un correo o un teléfono en el texto de la ruta.
    const patron = patronDeRuta(request);
    const cliente = request.headers['x-client-source'];
    return {
      distributorId: request.distributorId ?? null,
      actorUserId: request.user?.user_id ?? null,
      actorRole: request.user?.actor_real_role ?? request.user?.role ?? null,
      httpMethod: request.method,
      resource: recursoDe(patron),
      resourceId: idDelRecurso(request.params),
      path: patron.slice(0, 255),
      clientSource: typeof cliente === 'string' ? cliente.slice(0, 30) : null,
      ip: ipDe(request),
      result,
      statusCode,
      changes: depurarCambios(request.body),
      errorMessage: errorMsg,
    };
  }
}

/** El patrón de la ruta que atendió el pedido; Express lo tipa como any. */
function patronDeRuta(request: Request): string {
  const ruta: unknown = request.route;
  if (typeof ruta === 'object' && ruta !== null && 'path' in ruta) {
    const { path } = ruta;
    if (typeof path === 'string') return path;
  }
  return request.path;
}

function ipDe(request: Request): string | null {
  const ip: unknown = request.ip;
  return typeof ip === 'string' && ip ? ip.slice(0, 45) : null;
}

/** El primer segmento después de /api: orders, users, delivery... */
function recursoDe(ruta: string): string {
  const segmentos = ruta.split('/').filter(Boolean);
  let i = segmentos[0] === 'api' ? 1 : 0;
  // Con el versionado por URI la ruta es /api/v1/orders: el recurso es `orders`, no `v1`.
  if (/^v\d+$/.test(segmentos[i] ?? '')) i += 1;
  return (segmentos[i] ?? 'raiz').slice(0, 60);
}

/** `:id` si la ruta lo tiene; si no, el primer parámetro (`:userId`...). */
function idDelRecurso(params: Record<string, string>): string | null {
  const valor = params.id ?? Object.values(params)[0];
  return valor ? valor.slice(0, 64) : null;
}

/**
 * El motivo que ve quien llamó: en una validación rechazada, los mensajes de
 * cada campo, no el genérico "Bad Request Exception".
 */
function motivoDelRechazo(error: unknown): string {
  if (error instanceof HttpException) {
    // El mismo texto en castellano que recibe el cliente (lo arma el filtro global).
    const cuerpo = traducirExcepcion(error).getResponse();
    if (typeof cuerpo === 'object' && cuerpo !== null && 'message' in cuerpo) {
      const { message } = cuerpo;
      if (Array.isArray(message)) return message.map(String).join('; ');
      if (typeof message === 'string') return message;
    }
  }
  return errorMessage(error);
}

/** El código con que va a responder el filtro global de excepciones. */
function codigoDeError(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  if (error instanceof NotFoundDomainError) return 404;
  if (error instanceof BadRequestDomainError) return 400;
  return 500;
}
