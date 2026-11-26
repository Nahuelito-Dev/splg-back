import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, MENSAJE_TOKEN_INVALIDO } from '../auth.service';
import { UsersService } from '../../users/users.service';
import { RequestSource } from '../enum/request-source.enum';
import { User } from '../../users/entities/user.entity';
import { DistributorService } from '../../distributor/distributor.service';
import { RoleType } from '../../common/constants/role-type.enum';
import { SIN_DISTRIBUIDORA_KEY } from '../../common/decorators/sin-distribuidora.decorator';
import { resolverAlcance } from '../../common/alcance/resolver-alcance';
import { SupportSessionResolver } from '../../support/application/support-session.resolver';
import type { Request } from 'express';
import { requestDelContexto } from '../../common/contexto/request-del-contexto';

/** Encabezado con el que el super admin hace una consulta de soporte. */
export const ENCABEZADO_DE_SOPORTE = 'x-support-session';

/** Un uuid v4 canónico (para distinguir header X-Distributor id vs slug). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly distributorService: DistributorService,
    private readonly sesionesDeSoporte: SupportSessionResolver,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestDelContexto(context);

    const isPublic = this.reflector.get<boolean | undefined>(
      'isPublic',
      context.getHandler(),
    );

    if (isPublic) {
      const identificar = this.reflector.get<boolean | undefined>(
        'identificarSiHayToken',
        context.getHandler(),
      );
      if (identificar) {
        await this.identificarSiPuede(request, context);
      }
      return true;
    }

    const token = this.extractTokenFromHeader(request);
    const requestSource = this.extractRequestSourceFromHeader(request);

    if (!requestSource) {
      throw new UnauthorizedException(
        'Falta el encabezado X-Client-Source o no es válido',
      );
    }

    if (
      !token &&
      request.method === 'POST' &&
      request.url.includes('/auth/login')
    ) {
      const email = emailDelCuerpo(request.body);

      if (!email) {
        throw new UnauthorizedException('Falta el correo para iniciar sesión');
      }

      const user = await this.usersService.findOneByEmail(email);
      this.validateUserRoleForApp(user, requestSource);

      return true;
    }

    if (!token) {
      throw new UnauthorizedException('Falta el token de acceso');
    }

    await this.identificar(request, token, requestSource, context);

    return true;
  }

  /**
   * Para rutas `@PublicIdentificable()`: con token y `X-Client-Source`
   * válidos deja el usuario y la distribuidora en la request; en cualquier
   * otro caso la deja anónima (`distributorId = null`) sin rechazarla.
   */
  private async identificarSiPuede(
    request: Request,
    context: ExecutionContext,
  ): Promise<void> {
    request.distributorId = null;
    const token = this.extractTokenFromHeader(request);
    const requestSource = this.extractRequestSourceFromHeader(request);
    if (!token || !requestSource) return;
    try {
      await this.identificar(request, token, requestSource, context);
    } catch (error) {
      // Sólo un rechazo de autenticación (token vencido, usuario inexistente o
      // bloqueado) deja la request anónima. Una falla de infraestructura (la
      // base caída) se propaga: no se confunde con "no hay sesión".
      if (!(error instanceof HttpException)) throw error;
      request.user = undefined;
      request.distributorId = null;
    }
  }

  /** Valida el token, carga el usuario y deja usuario y tenant en la request. */
  private async identificar(
    request: Request,
    token: string,
    requestSource: RequestSource,
    context: ExecutionContext,
  ): Promise<void> {
    const token_user = await this.authService.decodeToken(token);

    if (!token_user.email) {
      throw new UnauthorizedException(MENSAJE_TOKEN_INVALIDO);
    }

    const local_user = await this.getUser(token_user.email, requestSource);

    // Rutas marcadas @SinDistribuidora() ignoran el HEADER, no el tenant:
    // el admin/chofer sigue acotado a la distribuidora de su perfil (y
    // sigue rechazado si no la tiene) igual que siempre. Sólo cambia para
    // customer/super_admin, que resuelven por header: ahí se trata como si
    // no hubiese header, así que uno residual o inexistente no rompe nada.
    // `getAllAndOverride` mira handler Y clase: si se marca el controller
    // entero, no queda ignorado en silencio a nivel método.
    const sinDistribuidora = this.reflector.getAllAndOverride<
      boolean | undefined
    >(SIN_DISTRIBUIDORA_KEY, [context.getHandler(), context.getClass()]);
    const distributor_id =
      local_user.role?.type === RoleType.SUPER_ADMIN
        ? await this.resolverSoporte(
            local_user,
            request,
            Boolean(sinDistribuidora),
            context,
          )
        : await this.resolveDistributor(local_user, request, sinDistribuidora);

    // getUser ya pasó por validateUserRoleForApp, que rechaza al usuario sin
    // rol o con un rol que no es de esta app: acá el rol es de RoleType.
    const actuaComoEmpresaPropia = request.ownedCompanyId !== undefined;
    // Dentro de una empresa propia el super admin no conserva privilegios de
    // plataforma: para TODA la autorización posterior es un admin de ese
    // tenant. El rol real queda separado, exclusivamente para la auditoría.
    const roleEfectivo = actuaComoEmpresaPropia
      ? RoleType.ADMIN
      : (local_user.role?.type as RoleType);
    request.user = {
      email: local_user.email ?? token_user.email,
      role: roleEfectivo,
      user_id: local_user.userId,
      distributor_id,
      support_session_id: request.supportSession?.id ?? null,
      actuaComoEmpresaPropia,
      actor_real_role: local_user.role?.type as RoleType,
    };
    // Tenant efectivo de la request (lo lee @CurrentDistributor()).
    request.distributorId = distributor_id;
  }

  /**
   * El tenant del super admin (modo soporte):
   *  - con `X-Support-Session` válida, la empresa es la de la sesión y la
   *    request queda marcada (`request.supportSession`) para el `AlcanceGuard`
   *    y la base (sólo lectura). El `X-Distributor` no se mira.
   *  - sin sesión, el `X-Distributor` sólo vale si nombra una empresa propia
   *    de la plataforma (`ownedByPlatform`, vigente): la request queda marcada
   *    (`request.ownedCompanyId`) y el super admin opera esa empresa directo.
   *    El de cualquier otra empresa se ignora: tenant `null`, así que lo de una
   *    empresa sigue cerrado (403 `SUPPORT_SESSION_REQUIRED`).
   *
   * Las rutas de plataforma y las `@SinDistribuidora()` no miran ninguno de
   * los dos: el panel puede consultar su sesión, salir o verificar la cuenta
   * aunque mande el encabezado de una sesión que ya terminó.
   */
  private async resolverSoporte(
    user: User,
    request: Request,
    sinDistribuidora: boolean,
    context: ExecutionContext,
  ): Promise<string | null> {
    request.supportSession = undefined;
    request.ownedCompanyId = undefined;
    if (sinDistribuidora) return null;
    const alcance = resolverAlcance(this.reflector, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (alcance === null || alcance === 'plataforma') return null;
    const header = request.headers[ENCABEZADO_DE_SOPORTE];
    if (header === undefined) return this.empresaPropia(request);
    const id = Array.isArray(header) ? header[0] : header;
    const sesion = await this.sesionesDeSoporte.vigente(id ?? '', user.userId);
    request.supportSession = sesion;
    return sesion.distributorId;
  }

  /**
   * La empresa propia de la plataforma del `X-Distributor`, si lo es (si no,
   * `null`: el header no abre nada). Se consulta en cada request.
   */
  private async empresaPropia(request: Request): Promise<string | null> {
    const header = request.headers['x-distributor'];
    if (typeof header !== 'string' || !header) return null;
    const id = await this.distributorService.empresaPropiaVigente(header);
    if (id === null) return null;
    request.ownedCompanyId = id;
    return id;
  }

  /**
   * Resuelve el tenant (distribuidora) efectivo de la request:
   *  - admin/delivery: se DERIVA de su perfil (server-trusted). Se ignora
   *    cualquier header X-Distributor → un staff no puede operar otro tenant.
   *    Esto NO cambia con `ignorarHeader`: el staff nunca lee el header, así
   *    que no hay nada que "ignorar" de más.
   *  - customer: del header `X-Distributor` (slug o uuid), validado
   *    contra una distribuidora activa. Sin header → null. Con
   *    `ignorarHeader` (ruta `@SinDistribuidora()`), se comporta como si el
   *    header no hubiese llegado: no lo lee, no lo valida, no puede romper.
   * Devuelve null si el customer aún no eligió distribuidora. El super_admin
   * no pasa por acá: lo resuelve `resolverSoporte`.
   */
  private async resolveDistributor(
    user: User,
    request: Request,
    ignorarHeader = false,
  ): Promise<string | null> {
    const role = user.role?.type;

    // Staff (admin/delivery) DEBE tener una distribuidora en su perfil. Si no la
    // tiene (dato inconsistente), NO se degrada a "ve todo" (eso sería fuga
    // cross-tenant): se rechaza. El super_admin es el único cross-tenant.
    if (role === RoleType.DELIVERY) {
      const id = user.delivery?.distributorId;
      if (!id) {
        throw new UnauthorizedException(
          'El chofer no tiene una distribuidora asignada',
        );
      }
      return id;
    }
    if (role === RoleType.ADMIN) {
      const id = user.admins?.[0]?.distributorId;
      if (!id) {
        throw new UnauthorizedException(
          'El admin no tiene una distribuidora asignada',
        );
      }
      return id;
    }

    // customer → header opcional, salvo que la ruta ya haya dicho que no lo
    // necesita: en ese caso ni se lee.
    if (ignorarHeader) {
      return null;
    }
    const header = request.headers['x-distributor'];
    if (!header || typeof header !== 'string') {
      return null;
    }
    try {
      const distributor = UUID_RE.test(header)
        ? await this.distributorService.assertActive(header)
        : await this.distributorService.findBySlug(header);
      return distributor.distributorId;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      throw new UnauthorizedException(
        `Distribuidora '${header}' inválida o no disponible`,
      );
    }
  }

  private extractTokenFromHeader(request: Request): string | null {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' && token ? token : null;
  }

  private async getUser(
    user_email: string,
    request_source: RequestSource,
  ): Promise<User> {
    let user: User;
    try {
      user = await this.usersService.findOneByEmail(user_email);
      this.validateUserRoleForApp(user, request_source);
    } catch (error) {
      // Una falla de infraestructura no es "usuario inexistente".
      if (!(error instanceof HttpException)) throw error;
      throw new UnauthorizedException(
        'Usuario inexistente o sin un rol válido para esta aplicación',
      );
    }

    // La cuenta bloqueada se rechaza acá y no dentro del try de arriba: si
    // fuera parte de ese bloque, el catch la confundiría con "usuario
    // inexistente" y el administrador que bloqueó no sabría si surtió efecto.
    //
    // Tiene que estar en el guard y no en el login, porque el panel y las dos
    // apps se autentican con el SDK de Firebase y nunca pasan por nuestro
    // endpoint de acceso: el guard es el único lugar por donde pasan todos.
    this.assertCuentaHabilitada(user);

    return user;
  }

  private assertCuentaHabilitada(user: User): void {
    if (user.blocked) {
      throw new UnauthorizedException(
        'La cuenta está bloqueada. Comuníquese con la distribuidora.',
      );
    }
  }

  private validateUserRoleForApp(
    user: User,
    requestSource: RequestSource,
  ): void {
    const userRole = user.role?.type;

    if (!userRole) {
      throw new UnauthorizedException('Tu usuario no tiene un rol asignado');
    }

    const validRolesForApp: Record<RequestSource, string[]> = {
      [RequestSource.ADMIN_PANEL]: ['admin', 'super_admin'],
      [RequestSource.CUSTOMER_APP]: ['customer'],
      [RequestSource.DELIVERY_APP]: ['delivery'],
    };

    if (!validRolesForApp[requestSource].includes(userRole)) {
      throw new UnauthorizedException(
        'Tu rol no tiene acceso a esta aplicación',
      );
    }
  }

  private extractRequestSourceFromHeader(
    request: Request,
  ): RequestSource | null {
    const requestSource = request.headers['x-client-source'];

    if (!requestSource) {
      return null;
    }

    switch (requestSource) {
      case 'panel-app':
        return RequestSource.ADMIN_PANEL;
      case 'customer-app':
        return RequestSource.CUSTOMER_APP;
      case 'delivery-app':
      case 'driver-app': // alias: la app chofer manda 'driver-app'
        return RequestSource.DELIVERY_APP;
      default:
        return null;
    }
  }
}

function emailDelCuerpo(cuerpo: unknown): string | null {
  if (typeof cuerpo === 'object' && cuerpo !== null && 'email' in cuerpo) {
    return typeof cuerpo.email === 'string' && cuerpo.email
      ? cuerpo.email
      : null;
  }
  return null;
}
