import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';
import { RoleType } from '../constants/role-type.enum';
import { ApiExtension } from '@nestjs/swagger';

/**
 * Permisos del equipo de la plataforma (diseño de comunicación §5.2). Un solo
 * par cubre el chat con las empresas y los tickets (D-C20); `configurar`
 * cubre el horario del chat, los objetivos de respuesta y las respuestas
 * guardadas.
 *
 * Hoy todo administrador general los tiene: los roles del equipo de la
 * plataforma (dueño, soporte, ventas, técnico) todavía no existen. Los
 * endpoints ya los declaran para que el guard los exija cuando lleguen.
 */
export const PERMISOS_DE_PLATAFORMA = [
  {
    clave: 'plataforma.tickets.ver',
    etiqueta: 'ver el chat con las empresas y los tickets',
  },
  {
    clave: 'plataforma.tickets.gestionar',
    etiqueta: 'atender el chat con las empresas y los tickets',
  },
  {
    clave: 'plataforma.tickets.configurar',
    etiqueta: 'configurar el soporte de la plataforma',
  },
] as const;

export type PermisoDePlataforma =
  (typeof PERMISOS_DE_PLATAFORMA)[number]['clave'];

export const PERMISO_DE_PLATAFORMA_KEY = 'permisoDePlataforma';

/** El permiso de plataforma que pide el endpoint (se documenta en Swagger como `x-permission`). */
export function PermisoDePlataforma(
  permiso: PermisoDePlataforma,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(PERMISO_DE_PLATAFORMA_KEY, permiso),
    ApiExtension('x-permission', permiso),
  );
}

/**
 * Permisos de plataforma efectivos de un usuario. Mientras no existan los
 * roles del equipo de la plataforma (P11), el criterio es el mismo que el de
 * los endpoints HTTP de C1: el administrador general los tiene todos y nadie
 * más tiene ninguno. Es el único lugar a cambiar cuando lleguen los roles.
 */
@Injectable()
export class PermisosDePlataformaService {
  deUsuario(_userId: string, role: RoleType): Promise<PermisoDePlataforma[]> {
    return Promise.resolve(
      role === RoleType.SUPER_ADMIN
        ? PERMISOS_DE_PLATAFORMA.map((p) => p.clave)
        : [],
    );
  }
}
