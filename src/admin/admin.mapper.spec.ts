import { AdminMapper } from './admin.mapper';
import { Admin } from './entities/admin.entity';
import { StaffRole } from './entities/staff-role.entity';

const admin = (staffRole?: StaffRole | null): Admin =>
  Object.assign(new Admin(), {
    adminId: 'a1',
    userId: 'u1',
    distributorId: 'd1',
    createdAt: new Date('2026-11-12T00:00:00Z'),
    ...(staffRole === undefined ? {} : { staffRole }),
  });

describe('AdminMapper.toDto — rol de personal (F37)', () => {
  it('trae el rol de personal resumido cuando se cargó', () => {
    const rol = Object.assign(new StaffRole(), {
      staffRoleId: 'r1',
      name: 'Operador',
      isSystem: false,
    });
    expect(AdminMapper.toDto(admin(rol)).staffRole).toEqual({
      staffRoleId: 'r1',
      name: 'Operador',
      isSystem: false,
    });
  });

  it('null para quien no tiene rol (super admin)', () => {
    expect(AdminMapper.toDto(admin(null)).staffRole).toBeNull();
  });

  it('si la consulta no cargó el rol, no inventa uno', () => {
    expect(AdminMapper.toDto(admin()).staffRole).toBeUndefined();
  });
});
