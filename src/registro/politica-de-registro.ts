import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';

/** Los roles que se pueden dar de alta. `qa_pruebas` no se crea por la API. */
export const ROLES_REGISTRABLES = [
  RoleType.CUSTOMER,
  RoleType.DELIVERY,
  RoleType.ADMIN,
  RoleType.SUPER_ADMIN,
] as const;
export type RolRegistrable = (typeof ROLES_REGISTRABLES)[number];

/**
 * Quién pide el alta:
 * - `anonimo`: la puerta pública, sin sesión.
 * - `usuario`: un administrador desde el panel.
 * - `sistema`: las herramientas del servidor (seed, comando de arranque), que
 *   sólo corre quien tiene acceso a la máquina.
 */
export type Solicitante =
  | { tipo: 'anonimo' }
  | { tipo: 'sistema' }
  | { tipo: 'usuario'; usuario: AuthenticatedUser };

export interface AltaAutorizada {
  rol: RolRegistrable;
  /** La distribuidora del perfil; null para clientes y super administradores. */
  distributorId: string | null;
}

/** Choferes y administradores trabajan para una distribuidora. */
function necesitaDistribuidora(rol: RolRegistrable): boolean {
  return rol === RoleType.DELIVERY || rol === RoleType.ADMIN;
}

/**
 * Decide si el solicitante puede dar de alta ese rol y en qué distribuidora.
 * Es la única regla de autorización del alta: la usan las dos puertas.
 *
 * - Sin sesión sólo se crea un cliente.
 * - Un admin crea clientes, choferes y admins, siempre en SU distribuidora
 *   (la del token; la del cuerpo sólo se acepta si coincide).
 * - Un super admin crea cualquier rol; choferes y admins van a la
 *   distribuidora que indique (cuerpo o `X-Distributor`).
 */
export function autorizarAlta(
  solicitante: Solicitante,
  rol: RolRegistrable,
  distributorIdPedido?: string,
): AltaAutorizada {
  if (solicitante.tipo === 'anonimo') {
    if (rol !== RoleType.CUSTOMER) {
      throw new ForbiddenException('Sin sesión sólo se registran clientes');
    }
    return { rol, distributorId: null };
  }

  if (solicitante.tipo === 'usuario') {
    const { usuario } = solicitante;

    if (usuario.role === RoleType.ADMIN) {
      if (rol === RoleType.SUPER_ADMIN) {
        throw new ForbiddenException('No podés crear un super administrador');
      }
      const propia = usuario.distributor_id;
      if (!propia) {
        throw new ForbiddenException(
          'Tu usuario no tiene una distribuidora asociada',
        );
      }
      if (distributorIdPedido && distributorIdPedido !== propia) {
        throw new ForbiddenException(
          'Sólo podés dar de alta usuarios de tu distribuidora',
        );
      }
      return { rol, distributorId: necesitaDistribuidora(rol) ? propia : null };
    }

    if (usuario.role !== RoleType.SUPER_ADMIN) {
      throw new ForbiddenException('No podés dar de alta usuarios');
    }
    return resolverDistribuidora(
      rol,
      distributorIdPedido ?? usuario.distributor_id ?? undefined,
    );
  }

  return resolverDistribuidora(rol, distributorIdPedido);
}

function resolverDistribuidora(
  rol: RolRegistrable,
  distributorId?: string,
): AltaAutorizada {
  if (!necesitaDistribuidora(rol)) {
    return { rol, distributorId: null };
  }
  if (!distributorId) {
    throw conCodigo(
      BadRequestException,
      400,
      'Falta la distribuidora: enviala en el cuerpo o en el header ' +
        'X-Distributor (slug o id).',
      CODIGOS_DE_ERROR.MISSING_DISTRIBUTOR,
    );
  }
  return { rol, distributorId };
}
