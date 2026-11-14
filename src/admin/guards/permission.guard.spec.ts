import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Controller, Get } from '@nestjs/common';
import { PermissionGuard } from './permission.guard';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { Public } from '../../common/decorators/isPublic.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  PermisosDelUsuario,
  StaffPermissionsService,
} from '../staff-permissions.service';
import type { Permiso as ClaveDePermiso } from '../../common/permisos/catalogo';

@Controller('prueba')
class PruebaController {
  @Get('libre')
  libre(): void {}

  @Get('pedidos')
  @Permiso('pedidos.gestionar')
  pedidos(): void {}

  @Get('ver')
  @Permiso('pedidos.ver')
  ver(): void {}

  @Get('varios')
  @Permiso('caja.anular', 'finanzas.gestionar')
  varios(): void {}

  @Get('publico')
  @Public()
  @Permiso('roles.gestionar')
  publico(): void {}
}

@Permiso('roles.gestionar')
@Controller('clase')
class ClaseController {
  @Get()
  listar(): void {}
}

function contexto(
  handler: () => void,
  clase: object,
  user?: Partial<AuthenticatedUser>,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => clase,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const admin = { user_id: 'u-1', role: RoleType.ADMIN };

describe('PermissionGuard', () => {
  let deUsuario: jest.Mock<Promise<PermisosDelUsuario>, [string, RoleType]>;
  let guard: PermissionGuard;
  const proto = PruebaController.prototype as unknown as Record<
    string,
    () => void
  >;

  const conPermisos = (permisos: ClaveDePermiso[]): void => {
    deUsuario.mockResolvedValue({ todos: false, rol: null, permisos });
  };

  beforeEach(() => {
    deUsuario = jest.fn<Promise<PermisosDelUsuario>, [string, RoleType]>();
    guard = new PermissionGuard(new Reflector(), {
      deUsuario,
    } as unknown as StaffPermissionsService);
  });

  it('sin @Permiso deja pasar sin consultar permisos', async () => {
    await expect(
      guard.canActivate(contexto(proto.libre, PruebaController, admin)),
    ).resolves.toBe(true);
    expect(deUsuario).not.toHaveBeenCalled();
  });

  it('una ruta pública pasa aunque declare permiso', async () => {
    await expect(
      guard.canActivate(contexto(proto.publico, PruebaController)),
    ).resolves.toBe(true);
  });

  it('el admin con el permiso pasa', async () => {
    conPermisos(['pedidos.gestionar', 'pedidos.ver']);
    await expect(
      guard.canActivate(contexto(proto.pedidos, PruebaController, admin)),
    ).resolves.toBe(true);
    expect(deUsuario).toHaveBeenCalledWith(
      'u-1',
      RoleType.ADMIN,
      undefined,
      false,
    );
  });

  it('el super admin dentro de la empresa propia pide los permisos como tal', async () => {
    conPermisos(['pedidos.gestionar']);
    await expect(
      guard.canActivate(
        contexto(proto.pedidos, PruebaController, {
          ...admin,
          actuaComoEmpresaPropia: true,
        }),
      ),
    ).resolves.toBe(true);
    expect(deUsuario).toHaveBeenCalledWith(
      'u-1',
      RoleType.ADMIN,
      undefined,
      true,
    );
  });

  it('el admin sin el permiso recibe 403 con la etiqueta y el code', async () => {
    conPermisos(['pedidos.ver']);
    const error = await guard
      .canActivate(contexto(proto.pedidos, PruebaController, admin))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      statusCode: 403,
      message: 'No tenés permiso para gestionar los pedidos',
      code: 'PERMISSION_DENIED',
    });
  });

  it('con varios permisos alcanza con uno; sin ninguno los nombra a todos', async () => {
    conPermisos(['finanzas.gestionar', 'finanzas.ver']);
    await expect(
      guard.canActivate(contexto(proto.varios, PruebaController, admin)),
    ).resolves.toBe(true);
    conPermisos([]);
    await expect(
      guard.canActivate(contexto(proto.varios, PruebaController, admin)),
    ).rejects.toThrow(
      'No tenés permiso para anular movimientos de caja ni para gestionar las finanzas',
    );
  });

  it('el permiso declarado en la clase vale para sus métodos', async () => {
    conPermisos(['pedidos.ver']);
    await expect(
      guard.canActivate(
        contexto(
          (ClaseController.prototype as unknown as Record<string, () => void>)
            .listar,
          ClaseController,
          admin,
        ),
      ),
    ).rejects.toThrow('No tenés permiso para gestionar los roles y permisos');
  });

  it('el super admin pasa siempre, sin consultar su rol', async () => {
    await expect(
      guard.canActivate(
        contexto(proto.pedidos, PruebaController, {
          user_id: 's',
          role: RoleType.SUPER_ADMIN,
        }),
      ),
    ).resolves.toBe(true);
    expect(deUsuario).not.toHaveBeenCalled();
  });

  it.each([RoleType.CUSTOMER, RoleType.DELIVERY])(
    'la cuenta %s no tiene rol de personal: el guard no la frena (lo hace @Auth)',
    async (role) => {
      await expect(
        guard.canActivate(
          contexto(proto.pedidos, PruebaController, { user_id: 'c', role }),
        ),
      ).resolves.toBe(true);
      expect(deUsuario).not.toHaveBeenCalled();
    },
  );

  it('sin usuario en la request, 403', async () => {
    await expect(
      guard.canActivate(contexto(proto.pedidos, PruebaController)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gestionar implica ver: lo resuelven los permisos efectivos del usuario', async () => {
    // StaffPermissionsService devuelve los efectivos (con el ver implícito).
    conPermisos(['pedidos.gestionar', 'pedidos.ver']);
    await expect(
      guard.canActivate(contexto(proto.ver, PruebaController, admin)),
    ).resolves.toBe(true);
  });
});
