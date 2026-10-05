import { rolDeAcceso } from './access-role';
import { JobPositionCategory } from '../entities/job-position.entity';
import { RoleType } from '../../common/constants/role-type.enum';

describe('rolDeAcceso (D1: sin roles nuevos)', () => {
  it.each([
    [JobPositionCategory.DRIVER, RoleType.DELIVERY],
    [JobPositionCategory.ADMINISTRATION, RoleType.ADMIN],
    [JobPositionCategory.MANAGEMENT, RoleType.ADMIN],
    [JobPositionCategory.HELPER, null],
    [JobPositionCategory.WAREHOUSE, null],
    [JobPositionCategory.SALES, null],
    [JobPositionCategory.OTHER, null],
  ])('%s -> %s', (categoria, rol) => {
    expect(rolDeAcceso(categoria)).toBe(rol);
  });
});
