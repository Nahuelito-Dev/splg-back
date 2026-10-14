import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import { RoleType } from '../constants/role-type.enum';

/** Respuesta 400 cuando una escritura exige distribuidora y no hay. */
export const MENSAJE_FALTA_DISTRIBUIDORA =
  'Falta la distribuidora: enviá el header X-Distributor (slug o id)';

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
 *
 * Con `{ required: 'staff' }` lo exige a todos los roles menos al cliente: es
 * para las escrituras que abren cliente y personal a la vez. El admin y el
 * chofer siempre traen su distribuidora (la del perfil); el que queda sin ella
 * es el super admin sin `X-Distributor`, que de otro modo operaría por UUID
 * sobre datos de cualquier distribuidora. El cliente no necesita tenant porque
 * sólo toca lo suyo (el dueño lo controla cada caso de uso).
 */
export const CurrentDistributor = createParamDecorator(
  (
    opts: { required?: boolean | 'staff' } | undefined,
    ctx: ExecutionContext,
  ) => {
    const request = ctx.switchToHttp().getRequest<Request>();

    // `distributorId` puede no existir en la request si el guard no corrió.
    if (!('distributorId' in request)) {
      throw new InternalServerErrorException(
        'CurrentDistributor usado en una ruta sin AuthGuard (o @Public sin contexto de tenant)',
      );
    }

    const distributorId = request.distributorId ?? null;

    const exige =
      opts?.required === 'staff'
        ? request.user?.role !== RoleType.CUSTOMER
        : Boolean(opts?.required);

    if (exige && !distributorId) {
      throw new BadRequestException(MENSAJE_FALTA_DISTRIBUIDORA);
    }

    return distributorId;
  },
);
