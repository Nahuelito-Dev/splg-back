import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Inyecta el `distributor_id` (tenant) efectivo de la request, resuelto por
 * `AuthGuard`:
 *   - admin/delivery → su distribuidora (derivada del perfil, no del header).
 *   - customer/super_admin → la del header `X-Distributor` (slug o uuid).
 *   - super_admin sin header → `null` (cross-tenant).
 *
 * Uso:
 *   findMine(@CurrentDistributor() distributorId: string | null) { ... }
 *   create(@CurrentDistributor({ required: true }) distributorId: string) { ... }
 *
 * Con `{ required: true }` lanza 400 si no hay tenant en contexto (útil en
 * escrituras que SIEMPRE deben pertenecer a una distribuidora, como crear un
 * pedido: el cliente debe elegir la distribuidora vía `X-Distributor`).
 */
export const CurrentDistributor = createParamDecorator(
  (opts: { required?: boolean } | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();

    // `distributorId` puede no existir en la request si el guard no corrió.
    if (!('distributorId' in request)) {
      throw new InternalServerErrorException(
        'CurrentDistributor usado en una ruta sin AuthGuard (o @Public sin contexto de tenant)',
      );
    }

    const distributorId = request.distributorId ?? null;

    if (opts?.required && !distributorId) {
      throw new BadRequestException(
        'Falta la distribuidora: enviá el header X-Distributor (slug o id)',
      );
    }

    return distributorId;
  },
);
