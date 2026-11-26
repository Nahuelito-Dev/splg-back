import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  esGraphql,
  requestDelContexto,
} from '../../common/contexto/request-del-contexto';
import type { ModuloKey } from '../modules/catalogo-de-modulos';
import { AccesoDeLaEmpresa } from './acceso-de-la-empresa.service';
import { moduloDeshabilitado } from './errores';
import { REQUIERE_MODULO_KEY } from './requiere-modulo.decorator';

/**
 * Guard GLOBAL, último de la cadena (después de `AlcanceGuard`): un endpoint
 * marcado `@RequiereModulo(m)` responde 403 `MODULE_DISABLED` si la empresa
 * de la request (`request.distributorId`, ya resuelto por `AuthGuard`: perfil
 * del staff, `X-Distributor` del cliente, sesión de soporte o empresa propia)
 * no tiene `m` habilitado. Sin tenant no decide: lo que el endpoint haga sin
 * distribuidora lo resuelve el endpoint (400 `MISSING_DISTRIBUTOR` o lo suyo).
 */
@Injectable()
export class ModuloGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly acceso: AccesoDeLaEmpresa,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http' && !esGraphql(ctx)) return true;
    const modulo = this.reflector.getAllAndOverride<ModuloKey | undefined>(
      REQUIERE_MODULO_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!modulo) return true;
    const request = requestDelContexto(ctx);
    const distributorId = request.distributorId;
    if (!distributorId) return true;
    if (await this.acceso.habilitado(distributorId, modulo)) return true;
    throw moduloDeshabilitado();
  }
}
