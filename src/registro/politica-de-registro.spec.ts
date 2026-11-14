import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Solicitante, autorizarAlta } from './politica-de-registro';

/**
 * La única regla de autorización del alta. Cada caso es una fila de la tabla
 * "quién puede crear qué" de CU-082.
 */
describe('autorizarAlta', () => {
  const usuario = (
    role: RoleType,
    distributor_id: string | null = null,
  ): Solicitante => ({
    tipo: 'usuario',
    usuario: {
      user_id: 'u',
      email: 'x@x.com',
      role,
      distributor_id,
    } as AuthenticatedUser,
  });
  const anonimo: Solicitante = { tipo: 'anonimo' };
  const sistema: Solicitante = { tipo: 'sistema' };

  describe('sin sesión', () => {
    it('crea un cliente, sin distribuidora', () => {
      expect(autorizarAlta(anonimo, RoleType.CUSTOMER)).toEqual({
        rol: RoleType.CUSTOMER,
        distributorId: null,
      });
    });

    it.each([RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN])(
      'no crea %s',
      (rol) => {
        expect(() => autorizarAlta(anonimo, rol)).toThrow(ForbiddenException);
      },
    );
  });

  describe('admin de una distribuidora', () => {
    const admin = usuario(RoleType.ADMIN, 'd1');

    it.each([RoleType.DELIVERY, RoleType.ADMIN])(
      'crea %s en SU distribuidora',
      (rol) => {
        expect(autorizarAlta(admin, rol)).toEqual({ rol, distributorId: 'd1' });
      },
    );

    it('un cliente no queda atado a su distribuidora', () => {
      expect(autorizarAlta(admin, RoleType.CUSTOMER).distributorId).toBeNull();
    });

    it('no crea un super admin', () => {
      expect(() => autorizarAlta(admin, RoleType.SUPER_ADMIN)).toThrow(
        ForbiddenException,
      );
    });

    it('no da de alta en otra distribuidora', () => {
      expect(() => autorizarAlta(admin, RoleType.DELIVERY, 'd2')).toThrow(
        ForbiddenException,
      );
    });

    it('acepta la suya si la manda', () => {
      expect(autorizarAlta(admin, RoleType.DELIVERY, 'd1').distributorId).toBe(
        'd1',
      );
    });

    it('sin distribuidora propia no crea nada', () => {
      expect(() =>
        autorizarAlta(usuario(RoleType.ADMIN, null), RoleType.CUSTOMER),
      ).toThrow(ForbiddenException);
    });
  });

  describe('super admin', () => {
    it('crea choferes y admins en la distribuidora que indique', () => {
      expect(
        autorizarAlta(usuario(RoleType.SUPER_ADMIN), RoleType.ADMIN, 'd7'),
      ).toEqual({ rol: RoleType.ADMIN, distributorId: 'd7' });
    });

    it('si no la indica, usa la de X-Distributor', () => {
      expect(
        autorizarAlta(usuario(RoleType.SUPER_ADMIN, 'd3'), RoleType.DELIVERY)
          .distributorId,
      ).toBe('d3');
    });

    it('un chofer sin distribuidora es 400, no un chofer huérfano', () => {
      expect(() =>
        autorizarAlta(usuario(RoleType.SUPER_ADMIN), RoleType.DELIVERY),
      ).toThrow(BadRequestException);
    });

    it('un super admin nuevo no pertenece a ninguna distribuidora', () => {
      expect(
        autorizarAlta(usuario(RoleType.SUPER_ADMIN, 'd3'), RoleType.SUPER_ADMIN)
          .distributorId,
      ).toBeNull();
    });
  });

  describe('super admin operando una empresa propia de la plataforma', () => {
    const enPropia: Solicitante = {
      tipo: 'usuario',
      usuario: {
        user_id: 'u',
        email: 'x@x.com',
        role: RoleType.ADMIN,
        distributor_id: 'propia',
        actuaComoEmpresaPropia: true,
        actor_real_role: RoleType.SUPER_ADMIN,
      } as AuthenticatedUser,
    };

    it('da de alta choferes y admins en la propia', () => {
      expect(autorizarAlta(enPropia, RoleType.DELIVERY)).toEqual({
        rol: RoleType.DELIVERY,
        distributorId: 'propia',
      });
    });

    it('no da de alta en otra empresa por el cuerpo', () => {
      expect(() => autorizarAlta(enPropia, RoleType.ADMIN, 'otra')).toThrow(
        ForbiddenException,
      );
    });

    it('no crea un super admin desde la empresa', () => {
      expect(() => autorizarAlta(enPropia, RoleType.SUPER_ADMIN)).toThrow(
        ForbiddenException,
      );
    });
  });

  it.each([RoleType.CUSTOMER, RoleType.DELIVERY])(
    'un %s con sesión no da de alta a nadie',
    (role) => {
      expect(() =>
        autorizarAlta(usuario(role, 'd1'), RoleType.CUSTOMER),
      ).toThrow(ForbiddenException);
    },
  );

  it('el sistema (seed, comando) crea cualquier rol con su distribuidora', () => {
    expect(
      autorizarAlta(sistema, RoleType.SUPER_ADMIN).distributorId,
    ).toBeNull();
    expect(autorizarAlta(sistema, RoleType.DELIVERY, 'd1').distributorId).toBe(
      'd1',
    );
  });
});
