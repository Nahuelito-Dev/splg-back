import { InstallmentStatus, PolicyStatus } from '../domain/insurance.enums';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { Insurer } from '../entities/insurer.entity';
import { InsuranceMapper } from './insurance.mapper';

const insurer = {
  insurerId: 'i1',
  name: 'Seguros Rivadavia',
  taxId: '30500050205',
  phone: null,
  email: null,
  website: null,
  paymentUrl: 'https://pagos.rivadavia.test',
  notes: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
} as Insurer;

const cuota = (n: number, over: Partial<InsuranceInstallment> = {}) =>
  ({
    installmentId: `q${n}`,
    policyId: 'p1',
    number: n,
    total: 6,
    dueDate: '2026-11-22',
    graceUntil: '2026-11-27',
    amount: 29958,
    status: InstallmentStatus.PENDING,
    paidAt: null,
    paidAmount: null,
    operationNumber: null,
    paidByUserId: null,
    cashMovementId: null,
    receiptAttachmentId: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
  }) as InsuranceInstallment;

describe('InsuranceMapper', () => {
  it('la póliza sale con aseguradora, estado derivado y cuotas ordenadas por número', () => {
    const poliza = {
      policyId: 'p1',
      carId: 'c1',
      car: { carPatent: 'OVQ621' },
      insurer,
      policyNumber: '67/02/192143',
      coverage: 'Todo riesgo',
      validFrom: '2026-06-22',
      validTo: '2026-12-22',
      paymentCode: '0001',
      cancelledAt: null,
      cancelReason: null,
      installments: [cuota(3), cuota(1), cuota(2)],
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    } as unknown as InsurancePolicy;

    const dto = InsuranceMapper.policy(poliza, '2026-10-28');

    expect(dto.status).toBe(PolicyStatus.ACTIVE);
    expect(dto.carPatent).toBe('OVQ621');
    expect(dto.insurer.paymentUrl).toBe('https://pagos.rivadavia.test');
    expect(dto.installments.map((c) => c.label)).toEqual(['1/6', '2/6', '3/6']);
  });

  it('la cuota paga expone comprobante y movimiento de caja', () => {
    const dto = InsuranceMapper.installment(
      cuota(5, {
        status: InstallmentStatus.PAID,
        paidAt: new Date('2026-11-20T17:30:00.000Z'),
        paidAmount: 29958,
        operationNumber: '88',
        paidByUserId: 'u1',
        cashMovementId: 'mov1',
        receiptAttachmentId: 'a1',
      }),
    );
    expect(dto).toMatchObject({
      label: '5/6',
      status: 'paid',
      cashMovementId: 'mov1',
      receiptAttachmentId: 'a1',
    });
  });

  it('el detalle de la cuota trae vehículo, póliza y enlace de pago', () => {
    const dto = InsuranceMapper.installmentDetail(
      cuota(1, {
        policy: {
          carId: 'c1',
          car: { carPatent: 'OVQ621' },
          policyNumber: 'N1',
          insurerId: 'i1',
          insurer,
        } as unknown as InsurancePolicy,
      }),
    );
    expect(dto).toMatchObject({
      carId: 'c1',
      carPatent: 'OVQ621',
      policyNumber: 'N1',
      insurerName: 'Seguros Rivadavia',
      paymentUrl: 'https://pagos.rivadavia.test',
    });
  });

  it('el seguro del vehículo sin póliza vigente deja current en null', () => {
    const dto = InsuranceMapper.carInsurance('c1', null, []);
    expect(dto).toEqual({ carId: 'c1', current: null, history: [] });
  });
});
