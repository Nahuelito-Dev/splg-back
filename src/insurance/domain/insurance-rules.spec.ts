import {
  conGraciaVencida,
  debePedirAprobacion,
  pagoBloqueadoPorAprobacion,
  puedeAprobarse,
  superaElImporteAprobado,
  estadoDeLaPoliza,
  polizaPorVencer,
  vencePronto,
} from './insurance-rules';
import {
  InstallmentApprovalStatus as Aprobacion,
  InstallmentStatus,
  PolicyStatus,
} from './insurance.enums';

describe('estadoDeLaPoliza', () => {
  const p = {
    validFrom: '2026-06-22',
    validTo: '2026-12-22',
    cancelledAt: null,
  };

  it.each([
    ['2026-06-21', PolicyStatus.UPCOMING],
    ['2026-06-22', PolicyStatus.ACTIVE],
    ['2026-12-21', PolicyStatus.ACTIVE],
    ['2026-12-22', PolicyStatus.EXPIRED],
  ])('hoy %s: %s', (hoy, esperado) => {
    expect(estadoDeLaPoliza(p, hoy)).toBe(esperado);
  });

  it('una póliza cancelada lo es, esté en la fecha que esté', () => {
    expect(
      estadoDeLaPoliza({ ...p, cancelledAt: new Date() }, '2026-07-01'),
    ).toBe(PolicyStatus.CANCELLED);
  });
});

describe('avisos de cuotas', () => {
  const pendiente = (dueDate: string, graceUntil = dueDate) => ({
    status: InstallmentStatus.PENDING,
    dueDate,
    graceUntil,
  });

  it('vence pronto: dentro de los días indicados, inclusive, y las ya vencidas', () => {
    expect(vencePronto(pendiente('2026-11-05'), '2026-10-31', 5)).toBe(true);
    expect(vencePronto(pendiente('2026-11-06'), '2026-10-31', 5)).toBe(false);
    expect(vencePronto(pendiente('2026-10-01'), '2026-10-31', 5)).toBe(true);
  });

  it('una cuota paga o cancelada no avisa', () => {
    for (const status of [
      InstallmentStatus.PAID,
      InstallmentStatus.CANCELLED,
    ]) {
      const c = { ...pendiente('2026-10-01'), status };
      expect(vencePronto(c, '2026-10-31', 5)).toBe(false);
      expect(conGraciaVencida(c, '2026-12-31')).toBe(false);
    }
  });

  it('la gracia está vencida recién al día siguiente de graceUntil', () => {
    const c = pendiente('2026-11-22', '2026-11-27');
    expect(conGraciaVencida(c, '2026-11-27')).toBe(false);
    expect(conGraciaVencida(c, '2026-11-28')).toBe(true);
  });
});

describe('polizaPorVencer', () => {
  const p = { validTo: '2026-12-22', cancelledAt: null };

  it('vence dentro de 30 días, inclusive el último y el mismo día', () => {
    expect(polizaPorVencer(p, '2026-11-22', 30)).toBe(true);
    expect(polizaPorVencer(p, '2026-11-21', 30)).toBe(false);
    expect(polizaPorVencer(p, '2026-12-22', 30)).toBe(true);
  });

  it('una vencida o cancelada no avisa', () => {
    expect(polizaPorVencer(p, '2026-12-23', 30)).toBe(false);
    expect(
      polizaPorVencer({ ...p, cancelledAt: new Date() }, '2026-12-01', 30),
    ).toBe(false);
  });
});

describe('aprobación del pago de una cuota', () => {
  const E = InstallmentStatus;
  const HOY = '2026-11-10';

  it.each([
    [E.PENDING, Aprobacion.NONE, '2026-11-10', true],
    [E.PENDING, Aprobacion.NONE, '2026-11-15', true],
    [E.PENDING, Aprobacion.NONE, '2026-11-16', false], // más lejos que 5 días
    [E.PENDING, Aprobacion.NONE, '2026-11-09', false], // ya vencida: no hay ola de pedidos
    [E.PENDING, Aprobacion.AWAITING, '2026-11-12', false],
    [E.PENDING, Aprobacion.APPROVED, '2026-11-12', false],
    [E.PAID, Aprobacion.NONE, '2026-11-12', false],
    [E.CANCELLED, Aprobacion.NONE, '2026-11-12', false],
  ])(
    'debePedirAprobacion(%s, %s, vence %s) = %s',
    (status, approvalStatus, dueDate, esperado) => {
      expect(
        debePedirAprobacion({ status, approvalStatus, dueDate }, HOY, 5),
      ).toBe(esperado);
    },
  );

  it.each([
    [E.PENDING, Aprobacion.AWAITING, true],
    [E.PENDING, Aprobacion.NONE, true],
    [E.PENDING, Aprobacion.APPROVED, false],
    [E.PAID, Aprobacion.AWAITING, false],
    [E.CANCELLED, Aprobacion.NONE, false],
  ])('puedeAprobarse(%s, %s) = %s', (status, approvalStatus, esperado) => {
    expect(puedeAprobarse({ status, approvalStatus })).toBe(esperado);
  });

  it('sólo la aprobada se puede pagar', () => {
    expect(
      pagoBloqueadoPorAprobacion({ approvalStatus: Aprobacion.AWAITING }),
    ).toBe(true);
    expect(
      pagoBloqueadoPorAprobacion({ approvalStatus: Aprobacion.NONE }),
    ).toBe(true);
    expect(
      pagoBloqueadoPorAprobacion({ approvalStatus: Aprobacion.APPROVED }),
    ).toBe(false);
  });

  it('no se paga más que el importe aprobado', () => {
    expect(superaElImporteAprobado({ amount: 100 }, 100.01)).toBe(true);
    expect(superaElImporteAprobado({ amount: 100 }, 100)).toBe(false);
    expect(superaElImporteAprobado({ amount: 100 }, 90)).toBe(false);
  });
});
