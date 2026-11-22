import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { IsNull, Not } from 'typeorm';
import { DocumentReadingDecisionService } from './document-reading-decision.service';
import {
  DocumentProposalAction,
  DocumentReading,
  DocumentReadingStatus,
} from './entities/document-reading.entity';
import { DocumentReadingExample } from './entities/document-reading-example.entity';

const CAJA = '11111111-1111-4111-8111-111111111111';
const VENCE = new Date('2026-11-06T12:00:00.123Z');

const lectura = (
  action: DocumentProposalAction = 'pay_installment',
  campos: Record<string, string | null> = {
    importe: '29958.00',
    fecha_de_pago: '2026-11-04T09:15:00-03:00',
    numero_de_operacion: '556677001',
  },
  extra: Partial<DocumentReading> = {},
): DocumentReading =>
  ({
    readingId: 'r1',
    distributorId: 'd1',
    attachmentId: 'a1',
    status: DocumentReadingStatus.PROPOSED,
    detectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
    expectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
    decidedAt: null,
    proposalExpiresAt: VENCE,
    remindedAt: null,
    escalatedAt: null,
    fields: Object.entries(campos).map(([nombre, valor]) => ({
      nombre,
      valor,
      confianza: 'alta',
    })),
    proposal: {
      action,
      ownerType: 'insurance_installment',
      ownerId: 'cuota-1',
      expected: {},
      read: {},
      differences: [],
      summary: 'Listo',
    },
    ...extra,
  }) as unknown as DocumentReading;

describe('DocumentReadingDecisionService', () => {
  let readings: { findOne: jest.Mock; update: jest.Mock };
  let examples: { save: jest.Mock; create: jest.Mock };
  let installments: { pagarEn: jest.Mock };
  let fines: { pagarEn: jest.Mock };
  let policies: { actualizarDesdeLectura: jest.Mock };
  let fleetTasks: {
    renovarDocumentoDesdeLectura: jest.Mock;
    avisarCasosCerrados: jest.Mock;
  };
  let receipts: { registrarFacturaDesdeLectura: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let service: DocumentReadingDecisionService;

  beforeEach(() => {
    readings = {
      findOne: jest.fn().mockResolvedValue(lectura()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    examples = {
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      // Como TypeORM: `create` no agrega valores por omisión.
      create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
    };
    installments = { pagarEn: jest.fn().mockResolvedValue(undefined) };
    fines = { pagarEn: jest.fn().mockResolvedValue(undefined) };
    policies = {
      actualizarDesdeLectura: jest.fn().mockResolvedValue(undefined),
    };
    fleetTasks = {
      renovarDocumentoDesdeLectura: jest.fn().mockResolvedValue([]),
      avisarCasosCerrados: jest.fn().mockResolvedValue(undefined),
    };
    receipts = {
      registrarFacturaDesdeLectura: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn((fn: (manager: unknown) => Promise<unknown>) =>
        fn({
          update: readings.update,
          findOne: readings.findOne,
          create: examples.create,
          save: examples.save,
        }),
      ),
    };
    service = new DocumentReadingDecisionService(
      readings as never,
      examples as never,
      installments as never,
      fines as never,
      policies as never,
      fleetTasks as never,
      receipts as never,
      {
        parametros: jest.fn().mockResolvedValue({ amountTolerancePct: 1 }),
      } as never,
      dataSource as unknown as DataSource,
    );
  });

  type Llamada = [unknown, Record<string, unknown>, Record<string, unknown>];
  const llamadas = () => readings.update.mock.calls as Llamada[];
  const ultimoUpdate = () => llamadas()[llamadas().length - 1];

  it('confirmar una cuota la paga con lo leído y la caja elegida, y queda ejecutada', async () => {
    await service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1');
    expect(installments.pagarEn).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      {
        attachmentId: 'a1',
        amount: 29958,
        paidAt: '2026-11-04T09:15:00-03:00',
        operationNumber: '556677001',
        cashBoxId: CAJA,
      },
      'd1',
      'u1',
      // Confirmar la propuesta es la aprobación del admin que confirma.
      true,
    );
    expect(fines.pagarEn).not.toHaveBeenCalled();
    // Reclamo condicional, y después ejecutada.
    expect(llamadas()[0][1]).toMatchObject({
      readingId: 'r1',
      distributorId: 'd1',
      status: DocumentReadingStatus.PROPOSED,
      remindedAt: IsNull(),
      escalatedAt: IsNull(),
    });
    // El vencimiento se compara al milisegundo (una fila escrita con now() trae microsegundos).
    const vence = llamadas()[0][1].proposalExpiresAt as {
      type: string;
      objectLiteralParameters: Record<string, unknown>;
      getSql: (col: string) => string;
    };
    expect(vence.type).toBe('raw');
    expect(vence.objectLiteralParameters).toEqual({ vence: VENCE });
    expect(vence.getSql('"r"."proposal_expires_at"')).toBe(
      `date_trunc('milliseconds', "r"."proposal_expires_at") = :vence`,
    );
    expect(llamadas()[0][2]).toMatchObject({
      status: DocumentReadingStatus.CONFIRMED,
      decidedByUserId: 'u1',
      corrections: null,
      executed: false,
    });
    expect(ultimoUpdate()).toEqual([
      DocumentReading,
      {
        readingId: 'r1',
        distributorId: 'd1',
        status: DocumentReadingStatus.CONFIRMED,
      },
      { executed: true },
    ]);
    expect(examples.save).not.toHaveBeenCalled();
  });

  it('confirmar una multa la paga con el servicio de multas', async () => {
    readings.findOne.mockResolvedValue(lectura('pay_fine'));
    await service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1');
    expect(fines.pagarEn).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      expect.objectContaining({ amount: 29958, cashBoxId: CAJA }),
      'd1',
      'u1',
    );
    expect(installments.pagarEn).not.toHaveBeenCalled();
  });

  it('corregir paga con el valor corregido (normalizado) y guarda un ejemplo por campo cambiado', async () => {
    await service.corregir(
      'r1',
      {
        fields: { importe: '30000.00', numero_de_operacion: '556677001' },
        cashBoxId: CAJA,
        note: 'El importe estaba mal',
      },
      'd1',
      'u1',
    );
    expect(installments.pagarEn).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      expect.objectContaining({ amount: 30000 }),
      'd1',
      'u1',
      true,
    );
    expect(llamadas()[0][2]).toMatchObject({
      status: DocumentReadingStatus.CORRECTED,
      decisionNote: 'El importe estaba mal',
      corrections: [{ field: 'importe', read: '29958.00', value: '30000.00' }],
    });
    // El importe sirve para pagar, pero no se aprende porque sesga al lector.
    expect(examples.create).not.toHaveBeenCalled();
  });

  it('una corrección con formato inválido o de un campo ajeno es 400, sin tomar la propuesta', async () => {
    await expect(
      service.corregir(
        'r1',
        { fields: { importe: '29.958,00' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow(
      'Importe: el valor «29.958,00» no es válido (usá punto decimal y sin separador de miles, p. ej. 29958.00)',
    );
    await expect(
      service.corregir(
        'r1',
        { fields: { patente: 'AB123CD' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('no es un dato de este tipo de documento');
    await expect(
      service.corregir('r1', { fields: {}, cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('indicá al menos un dato');
    expect(readings.update).not.toHaveBeenCalled();
    expect(installments.pagarEn).not.toHaveBeenCalled();
  });

  it('sin caja, sin importe o sin fecha es 400 antes de tomar la propuesta', async () => {
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      'Caja: indicá la caja del pago',
    );
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', {
        importe: null,
        fecha_de_pago: '2026-11-04',
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('Importe: falta el importe');
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', { importe: '10.00', fecha_de_pago: null }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('Fecha de pago: falta la fecha');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('si el pago falla, la transacción revierte sin compensar ni guardar ejemplos', async () => {
    const error = new ConflictException('La cuota ya está paga');
    installments.pagarEn.mockRejectedValue(error);
    await expect(
      service.corregir(
        'r1',
        { fields: { importe: '30000.00' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toBe(error);
    expect(readings.update).toHaveBeenCalledTimes(1);
    expect(llamadas()[0][2]).toMatchObject({
      status: DocumentReadingStatus.CORRECTED,
    });
    expect(examples.save).not.toHaveBeenCalled();
  });

  it('otra distribuidora es 404; ya decidida o sin propuesta es 409; si otro la tomó antes, 409 sin pagar', async () => {
    readings.findOne.mockResolvedValueOnce(null);
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd2', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(readings.findOne).toHaveBeenCalledWith({
      where: { readingId: 'r1', distributorId: 'd2' },
    });

    readings.findOne.mockResolvedValueOnce(
      lectura('pay_installment', undefined, {
        status: DocumentReadingStatus.CONFIRMED,
        decidedAt: new Date(),
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('La propuesta ya fue resuelta');

    readings.findOne.mockResolvedValueOnce(
      lectura('pay_installment', undefined, {
        status: DocumentReadingStatus.READ,
        proposal: null,
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('no tiene una propuesta pendiente');

    // Otro admin la decidió entre la lectura y el reclamo.
    readings.update.mockResolvedValueOnce({ affected: 0 });
    readings.findOne.mockResolvedValueOnce(lectura()).mockResolvedValueOnce(
      lectura('pay_installment', undefined, {
        status: DocumentReadingStatus.CONFIRMED,
        decidedAt: new Date(),
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow(new ConflictException('La propuesta ya fue resuelta'));
    expect(installments.pagarEn).not.toHaveBeenCalled();
  });

  it('si el cron recordó o escaló la propuesta en el medio, 409 «La propuesta cambió» sin pagar', async () => {
    readings.update.mockResolvedValueOnce({ affected: 0 });
    readings.findOne.mockResolvedValueOnce(lectura()).mockResolvedValueOnce(
      lectura('pay_installment', undefined, {
        remindedAt: new Date(),
        proposalExpiresAt: new Date('2026-11-07T12:00:00Z'),
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('La propuesta cambió: volvé a abrirla');
    expect(installments.pagarEn).not.toHaveBeenCalled();
    expect(readings.update).toHaveBeenCalledTimes(1);
  });

  it('si el cron la devolvió a leída en el medio, 409 sin propuesta pendiente', async () => {
    readings.update.mockResolvedValueOnce({ affected: 0 });
    readings.findOne.mockResolvedValueOnce(lectura()).mockResolvedValueOnce(
      lectura('pay_installment', undefined, {
        status: DocumentReadingStatus.READ,
        proposal: null,
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('La lectura no tiene una propuesta pendiente');
  });

  it('un campo con nombre de Object.prototype es 400, no 500', async () => {
    for (const campo of ['constructor', 'toString', 'hasOwnProperty']) {
      await expect(
        service.corregir(
          'r1',
          { fields: { [campo]: 1 as unknown as string }, cashBoxId: CAJA },
          'd1',
          'u1',
        ),
      ).rejects.toThrow(
        `${campo.charAt(0).toUpperCase()}${campo.slice(1)}: tiene que ser texto`,
      );
    }
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('corregir sin la fecha cuando difiere sólo la fecha de pago es 400 con su mensaje', async () => {
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', undefined, {
        proposal: {
          ...lectura().proposal!,
          differences: [
            {
              field: 'fecha_de_pago',
              expected: '2026-11-05',
              read: '2026-11-04T09:15:00-03:00',
              message: '',
            },
          ],
        },
      }),
    );
    await expect(
      service.corregir(
        'r1',
        { fields: { numero_de_operacion: '999' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow(
      'Hay diferencias en la fecha de pago: indicá la fecha correcta',
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('Hay diferencias en la fecha de pago');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('el mismo importe con otros decimales o el mismo día argentino no son un cambio', async () => {
    await expect(
      service.corregir(
        'r1',
        { fields: { importe: '29958.0' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('No cambiaste ningún dato: usá confirmar');
    // 09:15 del 04/11 en Argentina; a las 23:30 AR ya es 05/11 en UTC.
    await expect(
      service.corregir(
        'r1',
        { fields: { fecha_de_pago: '2026-11-04' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('No cambiaste ningún dato: usá confirmar');
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', {
        importe: '29958.00',
        fecha_de_pago: '2026-11-04T23:30:00-03:00',
      }),
    );
    await expect(
      service.corregir(
        'r1',
        { fields: { fecha_de_pago: '2026-11-04' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('No cambiaste ningún dato: usá confirmar');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('rechazar exige motivo, no ejecuta nada y no pide caja', async () => {
    await expect(
      service.rechazar('r1', { reason: '   ' }, 'd1', 'u1'),
    ).rejects.toThrow('Motivo del rechazo');
    await service.rechazar(
      'r1',
      { reason: ' No es de esta cuota ' },
      'd1',
      'u1',
    );
    expect(llamadas()[0][2]).toMatchObject({
      status: DocumentReadingStatus.REJECTED,
      decisionNote: 'No es de esta cuota',
    });
    expect(installments.pagarEn).not.toHaveBeenCalled();
    expect(readings.update).toHaveBeenCalledTimes(1);
  });

  it('confirmar una póliza la actualiza dentro de la transacción y queda ejecutada', async () => {
    readings.findOne.mockResolvedValue(
      lectura('update_policy', {
        numero_de_poliza: 'P-1',
        vigencia_desde: '2026-01-01',
        vigencia_hasta: '2027-01-01',
        patente: 'AB123CD',
      }),
    );
    await service.confirmar('r1', {}, 'd1', 'u1');
    expect(policies.actualizarDesdeLectura).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      'd1',
      expect.objectContaining({ policyNumber: 'P-1' }),
    );
    expect(ultimoUpdate()[2]).toEqual({ executed: true });
  });

  it('registra la factura dentro del manager y rechaza una diferencia de total', async () => {
    readings.findOne.mockResolvedValue(
      lectura('register_purchase_invoice', {
        numero: '0001-00000042',
        total: '10.00',
      }),
    );
    await service.confirmar('r1', {}, 'd1', 'u1');
    expect(receipts.registrarFacturaDesdeLectura).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      'd1',
      {
        numero: '0001-00000042',
        total: '10.00',
        tolerancePct: 1,
        expected: {},
      },
    );
    expect(ultimoUpdate()[2]).toEqual({ executed: true });
    readings.findOne.mockResolvedValue(
      lectura(
        'register_purchase_invoice',
        { numero: '0001-00000042', total: '9.00' },
        {
          proposal: {
            ...lectura('register_purchase_invoice').proposal!,
            differences: [
              { field: 'total', expected: '10.00', read: '9.00', message: '' },
            ],
          },
        },
      ),
    );
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      'Total: el importe',
    );
  });

  it('renueva el documento del empleado sólo si trae vencimiento', async () => {
    readings.findOne.mockResolvedValue(
      lectura(
        'update_employee_document',
        { vencimiento: '2027-01-01' },
        {
          detectedType: TipoDeDocumento.APTO_MEDICO,
        },
      ),
    );
    await service.confirmar(
      'r1',
      { fleetTaskId: '11111111-1111-4111-8111-111111111111' },
      'd1',
      'u1',
    );
    expect(fleetTasks.renovarDocumentoDesdeLectura).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      'd1',
      {
        documentKind: 'psychophysical',
        vencimiento: '2027-01-01',
        fechaDelDocumento: null,
        taskId: '11111111-1111-4111-8111-111111111111',
        attachmentId: 'a1',
        expected: {},
      },
    );
    expect(fleetTasks.avisarCasosCerrados).toHaveBeenCalledWith([]);
    expect(ultimoUpdate()[2]).toEqual({ executed: true });
  });

  const conDiferencia = (
    field: string,
    action: DocumentProposalAction,
  ): Partial<DocumentReading> => ({
    proposal: {
      ...lectura(action).proposal!,
      differences: [{ field, expected: 'a', read: 'b', message: '' }],
    },
  });

  it('patente distinta: sólo rechazar, sin tomar la propuesta', async () => {
    readings.findOne.mockResolvedValue(
      lectura(
        'update_policy',
        {
          numero_de_poliza: 'N',
          vigencia_desde: '2026-01-01',
          vigencia_hasta: '2027-01-01',
          patente: 'ZZ999ZZ',
        },
        conDiferencia('patente', 'update_policy'),
      ),
    );
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      'rechazá la propuesta',
    );
    expect(readings.update).not.toHaveBeenCalled();
  });

  it.each([
    ['numero_de_poliza', 'N'.repeat(41), 'Número de póliza'],
    ['numero_de_poliza', ' ', 'faltan número'],
  ])('póliza con %s inválido es 400', async (campo, valor, mensaje) => {
    readings.findOne.mockResolvedValue(
      lectura('update_policy', {
        vigencia_desde: '2026-01-01',
        vigencia_hasta: '2027-01-01',
        [campo]: valor,
      }),
    );
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      mensaje,
    );
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('factura sin número, con número largo o sin total corregido es 400', async () => {
    readings.findOne.mockResolvedValue(
      lectura('register_purchase_invoice', { numero: null, total: '1.00' }),
    );
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      'indicá el número',
    );
    readings.findOne.mockResolvedValue(
      lectura('register_purchase_invoice', {
        numero: 'N'.repeat(31),
        total: '1.00',
      }),
    );
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      'hasta 30',
    );
    readings.findOne.mockResolvedValue(
      lectura(
        'register_purchase_invoice',
        { numero: 'F-1', total: '1.00' },
        {
          ...conDiferencia('total', 'register_purchase_invoice'),
          detectedType: TipoDeDocumento.FACTURA_O_REMITO,
        },
      ),
    );
    await expect(
      service.corregir('r1', { fields: { numero: 'F-2' } }, 'd1', 'u1'),
    ).rejects.toThrow('indicá el importe');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('legajo: no apto y documento distinto sólo se rechazan', async () => {
    readings.findOne.mockResolvedValue(
      lectura(
        'update_employee_document',
        { vencimiento: '2027-01-01', resultado: 'No Apto' },
        { detectedType: TipoDeDocumento.APTO_MEDICO },
      ),
    );
    await expect(service.confirmar('r1', {}, 'd1', 'u1')).rejects.toThrow(
      'no apto',
    );
    readings.findOne.mockResolvedValue(
      lectura(
        'update_employee_document',
        { vencimiento: '2027-01-01', documento: '11111111' },
        {
          ...conDiferencia('documento', 'update_employee_document'),
          detectedType: TipoDeDocumento.APTO_MEDICO,
        },
      ),
    );
    await expect(
      service.corregir('r1', { fields: { documento: '22222222' } }, 'd1', 'u1'),
    ).rejects.toThrow('Documento');
    expect(readings.update).not.toHaveBeenCalled();
    await expect(
      service.rechazar('r1', { reason: 'no sirve' }, 'd1', 'u1'),
    ).resolves.toBeDefined();
  });

  it('sin vencimiento el legajo no se ejecuta; la licencia usa su tipo', async () => {
    readings.findOne.mockResolvedValue(lectura('update_employee_document', {}));
    await service.confirmar('r1', {}, 'd1', 'u1');
    expect(fleetTasks.renovarDocumentoDesdeLectura).not.toHaveBeenCalled();
    readings.findOne.mockResolvedValue(
      lectura(
        'update_employee_document',
        { vencimiento: '2027-01-01' },
        { detectedType: TipoDeDocumento.LICENCIA_DE_CONDUCIR },
      ),
    );
    await service.confirmar('r1', {}, 'd1', 'u1');
    expect(fleetTasks.renovarDocumentoDesdeLectura).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      'd1',
      expect.objectContaining({ documentKind: 'driver_license' }),
    );
  });

  it('exige corregir diferencias de importe o fecha antes de reclamar la propuesta', async () => {
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', undefined, {
        proposal: {
          ...lectura().proposal!,
          differences: [
            { field: 'importe', expected: '10.00', read: '9.00', message: '' },
          ],
        },
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('Hay diferencias en el importe del comprobante');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('corregir otro campo no puede saltear una diferencia de importe o fecha', async () => {
    readings.findOne.mockResolvedValue(
      lectura(
        'pay_installment',
        {
          importe: '9.00',
          fecha_de_pago: '2026-11-04',
          destinatario: 'Viejo',
        },
        {
          proposal: {
            ...lectura().proposal!,
            differences: [
              {
                field: 'importe',
                expected: '10.00',
                read: '9.00',
                message: '',
              },
              {
                field: 'fecha_de_pago',
                expected: '2026-11-05',
                read: '2026-11-04',
                message: '',
              },
            ],
          },
        },
      ),
    );
    await expect(
      service.corregir(
        'r1',
        { fields: { destinatario: 'Nuevo' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow(
      'Hay diferencias en el importe del comprobante: indicá el importe correcto',
    );
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('acepta explícitamente el mismo importe, lo normaliza y paga como corregida', async () => {
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', undefined, {
        proposal: {
          ...lectura().proposal!,
          differences: [
            {
              field: 'importe',
              expected: '30000.00',
              read: '29958.00',
              message: '',
            },
          ],
        },
      }),
    );
    await service.corregir(
      'r1',
      { fields: { importe: '29958.0' }, cashBoxId: CAJA },
      'd1',
      'u1',
    );
    expect(installments.pagarEn).toHaveBeenCalledWith(
      expect.anything(),
      'cuota-1',
      expect.objectContaining({ amount: 29958 }),
      'd1',
      'u1',
      true,
    );
    expect(llamadas()[0][2]).toMatchObject({
      status: DocumentReadingStatus.CORRECTED,
      corrections: [{ field: 'importe', read: '29958.00', value: '29958.00' }],
    });
    expect(examples.save).not.toHaveBeenCalled();
  });

  it('un valor corregido que no es texto devuelve 400 separado del largo', async () => {
    await expect(
      service.corregir(
        'r1',
        { fields: { importe: 29958 as unknown as string }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('Importe: tiene que ser texto');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('reclama la propuesta en el mismo punto del ciclo (sin recordar ni escalar desde que se abrió)', async () => {
    readings.findOne.mockResolvedValue(
      lectura(
        'update_policy',
        {
          numero_de_poliza: 'P-1',
          vigencia_desde: '2026-01-01',
          vigencia_hasta: '2027-01-01',
        },
        { remindedAt: new Date(), escalatedAt: null },
      ),
    );
    await service.confirmar('r1', {}, 'd1', 'u1');
    expect(llamadas()[0][1]).toMatchObject({
      remindedAt: Not(IsNull()),
      escalatedAt: IsNull(),
    });
  });

  it('valida largos y exige un cambio real antes de reclamar', async () => {
    await expect(
      service.corregir(
        'r1',
        { fields: { numero_de_operacion: 'x'.repeat(201) }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('cada valor puede tener hasta 200 caracteres');
    await expect(
      service.corregir(
        'r1',
        { fields: { numero_de_operacion: '556677001' }, cashBoxId: CAJA },
        'd1',
        'u1',
      ),
    ).rejects.toThrow('No cambiaste ningún dato: usá confirmar');
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', {
        importe: '10.00',
        fecha_de_pago: '2026-11-04',
        numero_de_operacion: 'x'.repeat(61),
      }),
    );
    await expect(
      service.confirmar('r1', { cashBoxId: CAJA }, 'd1', 'u1'),
    ).rejects.toThrow('Número de operación: hasta 60 caracteres');
    expect(readings.update).not.toHaveBeenCalled();
  });

  it('aprende sólo de campos de formato', async () => {
    readings.findOne.mockResolvedValue(
      lectura('pay_installment', {
        importe: '10.00',
        fecha_de_pago: '2026-11-04',
        destinatario: 'Viejo',
      }),
    );
    await service.corregir(
      'r1',
      { fields: { destinatario: 'Nuevo' }, cashBoxId: CAJA },
      'd1',
      'u1',
    );
    expect(examples.create).toHaveBeenCalledWith(DocumentReadingExample, {
      distributorId: 'd1',
      documentType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      field: 'destinatario',
      readValue: 'Viejo',
      correctValue: 'Nuevo',
      sourceReadingId: 'r1',
    });
  });
});
