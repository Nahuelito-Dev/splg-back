import { RoleType } from '../constants/role-type.enum';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import { esSuperAdminDePlataforma } from './alcance.util';

describe('esSuperAdminDePlataforma', () => {
  const usuario = (extra: Partial<AuthenticatedUser>): AuthenticatedUser => ({
    user_id: 'u',
    email: 'x@x.com',
    role: RoleType.SUPER_ADMIN,
    ...extra,
  });

  it('el super admin sin sesión ni empresa propia es de plataforma', () => {
    expect(esSuperAdminDePlataforma(usuario({}))).toBe(true);
  });

  it('en modo soporte no (ve la empresa como un admin)', () => {
    expect(
      esSuperAdminDePlataforma(usuario({ support_session_id: 's1' })),
    ).toBe(false);
  });

  it('operando una empresa propia tampoco (ve y escribe como un admin)', () => {
    expect(
      esSuperAdminDePlataforma(
        usuario({
          role: RoleType.ADMIN,
          distributor_id: 'propia',
          actuaComoEmpresaPropia: true,
        }),
      ),
    ).toBe(false);
  });

  it('un admin de empresa nunca', () => {
    expect(esSuperAdminDePlataforma(usuario({ role: RoleType.ADMIN }))).toBe(
      false,
    );
  });
});
