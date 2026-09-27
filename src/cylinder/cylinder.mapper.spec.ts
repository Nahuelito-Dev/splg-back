import { CylinderMapper } from './cylinder.mapper';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { User } from '../users/entities/user.entity';

const base = {
  cylinderId: 'c1',
  distributorId: 'd1',
  serial: 'SN-1',
  gasCylinderId: 'g1',
  state: CylinderState.WITH_CUSTOMER,
  currentCustomerId: 'u1',
  currentOrderId: 'o1',
  deposit: 5000,
  manufacturedAt: null,
  lastInspectionAt: null,
  createdAt: new Date('2026-09-26T10:00:00Z'),
  updatedAt: new Date('2026-09-26T10:00:00Z'),
} as unknown as Cylinder;

describe('CylinderMapper — lo que el panel muestra de un envase', () => {
  it('trae el producto y quién lo tiene cuando la consulta los cargó', () => {
    const dto = CylinderMapper.toDto({
      ...base,
      gasCylinder: { type: 'Garrafa 10kg', weight: 10 } as GasCylinder,
      currentCustomer: {
        userId: 'u1',
        fullName: 'María Benítez',
        phoneNumber: '+5493764281613',
      } as User,
    } as Cylinder);
    expect(dto.gas_cylinder).toEqual({ type: 'Garrafa 10kg', weight: 10 });
    expect(dto.current_customer).toEqual({
      user_id: 'u1',
      full_name: 'María Benítez',
      phone_number: '+5493764281613',
    });
  });

  it('sin relaciones cargadas devuelve null, no inventa datos', () => {
    const dto = CylinderMapper.toDto(base);
    expect(dto.gas_cylinder).toBeNull();
    expect(dto.current_customer).toBeNull();
    expect(dto.manufactured_at).toBeNull();
  });
});
