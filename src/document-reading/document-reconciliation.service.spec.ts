import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { DocumentReconciliationService } from './document-reconciliation.service';

const repo = (value: unknown = null) => ({
  findOne: jest.fn().mockResolvedValue(value),
});
const reading = (
  type: TipoDeDocumento,
  fields: Array<{ nombre: string; valor: string | null }> = [],
) =>
  ({
    readingId: 'r1',
    distributorId: 'd1',
    attachmentId: 'a1',
    detectedType: type,
    fields: fields.map((f) => ({ ...f, confianza: 'alta' })),
  }) as never;
const attachment = (ownerType: AttachmentOwnerType) => ({
  attachmentId: 'a1',
  distributorId: 'd1',
  ownerType,
  ownerId: 'o1',
});

describe('DocumentReconciliationService', () => {
  const settings = {
    parametros: jest
      .fn()
      .mockResolvedValue({ amountTolerancePct: 1, dateToleranceDays: 3 }),
  };
  const events = { emit: jest.fn() };
  const make = (
    a: unknown,
    installment: unknown = null,
    fine: unknown = null,
    policy: unknown = null,
    car: unknown = null,
    receipt: unknown = null,
    order: unknown = null,
    supplier: unknown = null,
    employee: unknown = null,
  ) =>
    new DocumentReconciliationService(
      repo(a) as never,
      repo(installment) as never,
      repo(fine) as never,
      repo(policy) as never,
      repo(car) as never,
      repo(receipt) as never,
      repo(order) as never,
      repo(supplier) as never,
      repo(employee) as never,
      settings as never,
      events as unknown as EventEmitter2,
    );
  beforeEach(() => jest.clearAllMocks());
  it('concilia cuota coincidente y marca cada diferencia relevante', async () => {
    const cuota = {
      status: 'pending',
      amount: 100,
      dueDate: '2025-03-01',
      policy: { insurer: { name: 'La Segunda' }, validFrom: '2025-01-01' },
    };
    await expect(
      make(
        attachment(AttachmentOwnerType.INSURANCE_INSTALLMENT),
        cuota,
      ).conciliar(
        reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
          { nombre: 'importe', valor: '100' },
          { nombre: 'destinatario', valor: 'LA SEGUNDA' },
          { nombre: 'fecha_de_pago', valor: '2025-01-02T00:00:00Z' },
        ]),
      ),
    ).resolves.toMatchObject({ action: 'pay_installment', differences: [] });
    const withDifferences = await make(
      attachment(AttachmentOwnerType.INSURANCE_INSTALLMENT),
      cuota,
    ).conciliar(
      reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
        { nombre: 'importe', valor: '80' },
        { nombre: 'destinatario', valor: 'Otra' },
        { nombre: 'fecha_de_pago', valor: '2024-01-01T00:00:00Z' },
      ]),
    );
    expect(withDifferences?.differences.map((d) => d.field)).toEqual([
      'importe',
      'destinatario',
      'fecha_de_pago',
    ]);
  });
  it.each([
    [
      AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
      TipoDeDocumento.COMPROBANTE_DE_PAGO,
      { voluntaryPaymentAmount: 90, amount: 100, jurisdiction: 'Municipio' },
      'pay_fine',
    ],
    [
      AttachmentOwnerType.INSURANCE_POLICY,
      TipoDeDocumento.POLIZA,
      {
        carId: 'c1',
        policyNumber: 'P1',
        validFrom: '2025-01-01',
        validTo: '2026-01-01',
      },
      'update_policy',
    ],
    [
      AttachmentOwnerType.PURCHASE_RECEIPT,
      TipoDeDocumento.FACTURA_O_REMITO,
      { supplierId: 's1', totalAmount: 100, purchaseOrderId: null },
      'register_purchase_invoice',
    ],
    [
      AttachmentOwnerType.EMPLOYEE,
      TipoDeDocumento.LICENCIA_DE_CONDUCIR,
      { documentNumber: '1', firstName: 'Ana', lastName: 'Paz' },
      'update_employee_document',
    ],
  ])(
    'propone la acción %s para cada dueño',
    async (owner, type, entity, action) => {
      const service =
        owner === AttachmentOwnerType.TRAFFIC_FINE_PAYMENT
          ? make(attachment(owner), null, entity)
          : owner === AttachmentOwnerType.INSURANCE_POLICY
            ? make(attachment(owner), null, null, entity, {
                carPatent: 'AA123BB',
              })
            : owner === AttachmentOwnerType.PURCHASE_RECEIPT
              ? make(attachment(owner), null, null, null, null, entity, null, {
                  cuit: '20123456789',
                })
              : make(
                  attachment(owner),
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  entity,
                );
      await expect(service.conciliar(reading(type))).resolves.toMatchObject({
        action,
      });
    },
  );
  it('cuota ya pagada: con su propio comprobante no hace nada; con otro avisa; cancelada va a revisión', async () => {
    const pago = reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
      { nombre: 'importe', valor: '100' },
    ]);
    const cuota = (status: string, receiptAttachmentId: string | null) => ({
      status,
      receiptAttachmentId,
      amount: 100,
      dueDate: '2025-03-01',
      policy: { insurer: { name: 'La Segunda' }, validFrom: '2025-01-01' },
    });
    const a = attachment(AttachmentOwnerType.INSURANCE_INSTALLMENT);
    await expect(
      make(a, cuota('paid', 'a1')).conciliar(pago),
    ).resolves.toBeNull();
    expect(events.emit).not.toHaveBeenCalled();
    await expect(
      make(a, cuota('paid', 'otro')).conciliar(pago),
    ).resolves.toBeNull();
    expect(events.emit).toHaveBeenCalledTimes(1);
    await expect(
      make(a, cuota('cancelled', null)).conciliar(pago),
    ).resolves.toMatchObject({
      action: 'review',
      summary: 'La cuota está cancelada: revisá el comprobante',
    });
  });
  it('multa ya pagada o anulada: su propio comprobante no hace nada; otro va a revisión', async () => {
    const pago = reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
      { nombre: 'importe', valor: '90' },
    ]);
    const multa = (status: string, receiptAttachmentId: string | null) => ({
      status,
      receiptAttachmentId,
      amount: 100,
      voluntaryPaymentAmount: 90,
      jurisdiction: 'Municipio',
    });
    const a = attachment(AttachmentOwnerType.TRAFFIC_FINE_PAYMENT);
    await expect(
      make(a, null, multa('paid', 'a1')).conciliar(pago),
    ).resolves.toBeNull();
    await expect(
      make(a, null, multa('paid', 'otro')).conciliar(pago),
    ).resolves.toMatchObject({ action: 'review' });
    await expect(
      make(a, null, multa('voided', null)).conciliar(pago),
    ).resolves.toMatchObject({
      action: 'review',
      summary: 'La multa está anulada: revisá el comprobante',
    });
    await expect(
      make(a, null, multa('pending', null)).conciliar(pago),
    ).resolves.toMatchObject({ action: 'pay_fine' });
  });
  it('todas las búsquedas del dueño y de sus datos filtran por la distribuidora de la lectura', async () => {
    const repos = Array.from({ length: 9 }, () => repo(null));
    const servicio = (dueno: AttachmentOwnerType, valores: unknown[]) => {
      repos.forEach((r, i) => r.findOne.mockResolvedValue(valores[i] ?? null));
      return new DocumentReconciliationService(
        ...(repos as never as [
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
        ]),
        settings as never,
        events as unknown as EventEmitter2,
      ).conciliar(
        reading(
          dueno === AttachmentOwnerType.INSURANCE_POLICY
            ? TipoDeDocumento.POLIZA
            : dueno === AttachmentOwnerType.PURCHASE_RECEIPT
              ? TipoDeDocumento.FACTURA_O_REMITO
              : dueno === AttachmentOwnerType.EMPLOYEE
                ? TipoDeDocumento.APTO_MEDICO
                : TipoDeDocumento.COMPROBANTE_DE_PAGO,
        ),
      );
    };
    const a = (o: AttachmentOwnerType) => attachment(o);
    await servicio(AttachmentOwnerType.INSURANCE_INSTALLMENT, [
      a(AttachmentOwnerType.INSURANCE_INSTALLMENT),
      { status: 'pending', amount: 1, policy: null },
    ]);
    await servicio(AttachmentOwnerType.TRAFFIC_FINE_PAYMENT, [
      a(AttachmentOwnerType.TRAFFIC_FINE_PAYMENT),
      null,
      {
        status: 'pending',
        amount: 1,
        jurisdiction: 'X',
        voluntaryPaymentAmount: null,
      },
    ]);
    await servicio(AttachmentOwnerType.INSURANCE_POLICY, [
      a(AttachmentOwnerType.INSURANCE_POLICY),
      null,
      null,
      {
        carId: 'c1',
        policyNumber: 'P',
        validFrom: '2026-01-01',
        validTo: '2027-01-01',
      },
      { carPatent: 'AB123CD' },
    ]);
    await servicio(AttachmentOwnerType.PURCHASE_RECEIPT, [
      a(AttachmentOwnerType.PURCHASE_RECEIPT),
      null,
      null,
      null,
      null,
      { supplierId: 's1', purchaseOrderId: 'po1', totalAmount: 10 },
      { totalAmount: 10 },
      { cuit: '20111111112' },
    ]);
    await servicio(AttachmentOwnerType.EMPLOYEE, [
      a(AttachmentOwnerType.EMPLOYEE),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      { documentNumber: '30111222', firstName: 'A', lastName: 'B' },
    ]);
    const llamadas = repos.flatMap(
      (r) =>
        r.findOne.mock.calls as Array<[{ where: Record<string, unknown> }]>,
    );
    // Adjunto ×5 + cuota, multa, póliza, auto, recepción, OC, proveedor y empleado.
    expect(llamadas).toHaveLength(13);
    for (const [opciones] of llamadas)
      expect(opciones.where).toEqual(
        expect.objectContaining({ distributorId: 'd1' }),
      );
  });
  it('multa: el voluntario vale sólo mientras está vigente; vencido se espera el total', async () => {
    const pago = (importe: string) =>
      reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
        { nombre: 'importe', valor: importe },
        { nombre: 'destinatario', valor: 'Municipalidad de Posadas' },
      ]);
    const multa = (dueDate: string) => ({
      status: 'pending',
      receiptAttachmentId: null,
      amount: 100000,
      voluntaryPaymentAmount: 50000,
      dueDate,
      jurisdiction: 'Posadas',
    });
    const a = attachment(AttachmentOwnerType.TRAFFIC_FINE_PAYMENT);
    await expect(
      make(a, null, multa('2099-01-01')).conciliar(pago('50000')),
    ).resolves.toMatchObject({ differences: [] });
    await expect(
      make(a, null, multa('2020-01-01')).conciliar(pago('100000')),
    ).resolves.toMatchObject({ differences: [] });
    const vencida = await make(a, null, multa('2020-01-01')).conciliar(
      pago('50000'),
    );
    expect(vencida?.differences.map((d) => d.field)).toEqual(['importe']);
  });
  it.each([
    ['La Segunda Cooperativa Ltda. de Seguros Generales', 'LA SEGUNDA', true],
    ['La Segunda Cooperativa', 'La Segunda Coop. Ltda.', true],
    ['Seguros Rivadavia', 'Cooperativa de Seguros Rivadavia Ltda.', true],
    ['Seguros Rivadavia', 'La Segunda Seguros', false],
    ['Federación Patronal', 'Seguros', false],
  ])('destinatario «%s» vs «%s» → coincide %s', async (esperado, leido, ok) => {
    const propuesta = await make(
      attachment(AttachmentOwnerType.INSURANCE_INSTALLMENT),
      {
        status: 'pending',
        amount: 100,
        policy: { insurer: { name: esperado }, validFrom: '2025-01-01' },
      },
    ).conciliar(
      reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
        { nombre: 'importe', valor: '100' },
        { nombre: 'destinatario', valor: leido },
        { nombre: 'fecha_de_pago', valor: '2025-02-01' },
      ]),
    );
    expect(propuesta?.differences.some((d) => d.field === 'destinatario')).toBe(
      !ok,
    );
  });
  it('fecha con hora cerca de medianoche se compara como día argentino, y un importe vacío es diferencia', async () => {
    const cuota = {
      status: 'pending',
      amount: 100,
      policy: { insurer: { name: 'La Segunda' }, validFrom: '2025-01-02' },
    };
    const a = attachment(AttachmentOwnerType.INSURANCE_INSTALLMENT);
    // 01:30 UTC del 02/01 = 22:30 del 01/01 en Argentina: anterior a la vigencia.
    const antes = await make(a, cuota).conciliar(
      reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
        { nombre: 'importe', valor: '100' },
        { nombre: 'destinatario', valor: 'La Segunda' },
        { nombre: 'fecha_de_pago', valor: '2025-01-02T01:30:00Z' },
      ]),
    );
    expect(antes?.differences.map((d) => d.field)).toEqual(['fecha_de_pago']);
    const sinImporte = await make(a, cuota).conciliar(
      reading(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
        { nombre: 'destinatario', valor: 'La Segunda' },
        { nombre: 'fecha_de_pago', valor: '2025-01-03' },
      ]),
    );
    expect(sinImporte?.differences.map((d) => d.field)).toEqual(['importe']);
  });
  it('póliza, compra y empleado: lo que coincide y cada diferencia (sin leer nada, no coincide)', async () => {
    const poliza = {
      carId: 'c1',
      policyNumber: '67/02-192143',
      validFrom: '2026-01-01',
      validTo: '2027-01-01',
    };
    const pol = attachment(AttachmentOwnerType.INSURANCE_POLICY);
    await expect(
      make(pol, null, null, poliza, { carPatent: 'AB123CD' }).conciliar(
        reading(TipoDeDocumento.POLIZA, [
          { nombre: 'patente', valor: 'AB 123 CD' },
          { nombre: 'numero_de_poliza', valor: '67/02/192143' },
          { nombre: 'vigencia_desde', valor: '2026-01-02' },
          { nombre: 'vigencia_hasta', valor: '2027-01-01' },
        ]),
      ),
    ).resolves.toMatchObject({ differences: [] });
    const vacia = await make(pol, null, null, poliza, null).conciliar(
      reading(TipoDeDocumento.POLIZA, []),
    );
    expect(vacia?.differences.map((d) => d.field)).toEqual([
      'patente',
      'numero_de_poliza',
      'vigencia_desde',
      'vigencia_hasta',
    ]);
    const rec = attachment(AttachmentOwnerType.PURCHASE_RECEIPT);
    const compra = (cuit: string | null, total: string) =>
      make(
        rec,
        null,
        null,
        null,
        null,
        { supplierId: 's1', purchaseOrderId: null, totalAmount: 1000 },
        null,
        { cuit: '30-50003691-1' },
      ).conciliar(
        reading(TipoDeDocumento.FACTURA_O_REMITO, [
          { nombre: 'cuit_del_emisor', valor: cuit },
          { nombre: 'total', valor: total },
        ]),
      );
    await expect(compra('30500036911', '1005')).resolves.toMatchObject({
      differences: [],
    });
    expect(
      (await compra(null, '2000'))?.differences.map((d) => d.field),
    ).toEqual(['cuit_del_emisor', 'total']);
    const emp = attachment(AttachmentOwnerType.EMPLOYEE);
    const empleado = (documento: string, vencimiento: string | null) =>
      make(emp, null, null, null, null, null, null, null, {
        documentNumber: '30.111.222',
        firstName: 'Ana',
        lastName: 'Paz',
      }).conciliar(
        reading(TipoDeDocumento.LICENCIA_DE_CONDUCIR, [
          { nombre: 'documento', valor: documento },
          { nombre: 'vencimiento', valor: vencimiento },
        ]),
      );
    await expect(empleado('30111222', '2027-05-01')).resolves.toMatchObject({
      differences: [],
      summary:
        'Documento del personal listo para confirmar. Trae vencimiento 2027-05-01 para actualizar.',
    });
    // Con diferencia, el vencimiento igual se informa.
    await expect(empleado('99999999', '2027-05-01')).resolves.toMatchObject({
      summary:
        'Revisá los datos del documento del personal. Trae vencimiento 2027-05-01 para actualizar.',
    });
  });
  it('un dueño sin conciliador no genera propuesta', async () => {
    await expect(
      make(attachment('cash_movement' as AttachmentOwnerType)).conciliar(
        reading(TipoDeDocumento.COMPROBANTE_DE_PAGO),
      ),
    ).resolves.toBeNull();
  });
  it('no encuentra dueño de otra distribuidora y el tipo incorrecto queda en revisión', async () => {
    await expect(
      make(attachment(AttachmentOwnerType.EMPLOYEE), null).conciliar(
        reading(TipoDeDocumento.LICENCIA_DE_CONDUCIR),
      ),
    ).resolves.toMatchObject({ action: 'review' });
    await expect(
      make(attachment(AttachmentOwnerType.INSURANCE_POLICY)).conciliar(
        reading(TipoDeDocumento.COMPROBANTE_DE_PAGO),
      ),
    ).resolves.toMatchObject({ action: 'review' });
  });
});
