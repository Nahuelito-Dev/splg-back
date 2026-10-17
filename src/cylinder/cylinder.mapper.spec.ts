import { CylinderMapper } from './cylinder.mapper';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { User } from '../users/entities/user.entity';
import { EstadoDeVigencia } from './domain/cylinder-vigencia';
import {
  CylinderInspection,
  CylinderInspectionResult,
} from './entities/cylinder-inspection.entity';

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

describe('CylinderMapper — vigencia', () => {
  const vencimiento = new Date('2026-12-01T00:00:00Z');
  const envase = {
    ...base,
    gasCylinder: { type: 'Garrafa 10kg', weight: 10 } as GasCylinder,
    lastInspectionAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: vencimiento,
  } as Cylinder;

  it('el vencimiento lleva el tipo de producto, el estado y los días', () => {
    const dto = CylinderMapper.vencimientoToDto({
      cylinder: envase,
      vigencia: { estado: EstadoDeVigencia.VIGENTE, diasRestantes: 45 },
    });
    expect(dto).toMatchObject({
      cylinderId: 'c1',
      serial: 'SN-1',
      productType: 'Garrafa 10kg',
      expiresAt: vencimiento,
      status: 'valid',
      daysRemaining: 45,
    });
  });

  it('la vigencia suma fabricación, retiro pendiente y el historial', () => {
    const dto = CylinderMapper.vigenciaToDto({
      cylinder: envase,
      vigencia: { estado: EstadoDeVigencia.VENCIDO, diasRestantes: -2 },
      retiroPendiente: true,
      inspections: [
        {
          inspectionId: 'i1',
          cylinderId: 'c1',
          inspectedAt: new Date('2026-10-01T00:00:00Z'),
          result: CylinderInspectionResult.REJECTED,
          nextDueAt: null,
          notes: null,
        } as CylinderInspection,
      ],
    });
    expect(dto.withdrawalPending).toBe(true);
    expect(dto.inspections).toEqual([
      expect.objectContaining({ inspectionId: 'i1', result: 'rejected' }),
    ]);
  });

  it('sin producto asignado el tipo es null', () => {
    const dto = CylinderMapper.vencimientoToDto({
      cylinder: { ...envase, gasCylinder: undefined } as Cylinder,
      vigencia: { estado: EstadoDeVigencia.SIN_ACREDITAR, diasRestantes: null },
    });
    expect(dto.productType).toBeNull();
  });

  it('agrupa el listado de vencimientos', () => {
    const item = {
      cylinder: envase,
      vigencia: { estado: EstadoDeVigencia.VIGENTE, diasRestantes: 1 },
    };
    const dto = CylinderMapper.vencimientosToDto({
      windowDays: 30,
      totals: { expired: 0, expiring: 1, unverified: 0 },
      expired: [],
      expiring: [item],
      unverified: [],
    });
    expect(dto.windowDays).toBe(30);
    expect(dto.expiring).toHaveLength(1);
    expect(dto.expired).toEqual([]);
  });
});
