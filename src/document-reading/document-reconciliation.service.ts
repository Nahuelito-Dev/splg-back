import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Attachment,
  AttachmentOwnerType,
} from '../attachment/entities/attachment.entity';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { Employee } from '../employee/entities/employee.entity';
import {
  TrafficFine,
  TrafficFineStatus,
} from '../fleet-expense/entities/traffic-fine.entity';
import { InsuranceInstallment } from '../insurance/entities/insurance-installment.entity';
import { InstallmentStatus } from '../insurance/domain/insurance.enums';
import { InsurancePolicy } from '../insurance/entities/insurance-policy.entity';
import { Car } from '../car/entities/car.entity';
import { importeEsperadoDeLaMulta } from '../fleet-expense/domain/importe-esperado-de-la-multa';
import { PurchaseReceipt } from '../purchase/entities/purchase-receipt.entity';
import { PurchaseOrder } from '../purchase/entities/purchase-order.entity';
import { Supplier } from '../purchase/entities/supplier.entity';
import {
  DocumentReading,
  DocumentProposal,
  DocumentProposalAction,
} from './entities/document-reading.entity';
import { DocumentReadingSettingsService } from './document-reading-settings.service';

type Valores = Record<string, string | null>;
const valor = (r: DocumentReading, nombre: string): string | null =>
  r.fields.find((f) => f.nombre === nombre)?.valor ?? null;
const normalizar = (v: string | null): string =>
  (v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/** Palabras que no distinguen a una empresa o a un organismo de otro. */
const GENERICAS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'y',
  'sa',
  'srl',
  'sas',
  'sau',
  'ltda',
  'coop',
  'cooperativa',
  'cia',
  'compania',
  'seguros',
  'seguro',
  'generales',
  'municipalidad',
  'municipio',
  'provincia',
  'gobierno',
  'direccion',
]);
const distintivas = (v: string): string[] =>
  v.split(' ').filter((t) => t.length >= 3 && !GENERICAS.has(t));
/** Iguales sin importar mayúsculas, tildes, puntuación ni espacios; vacío nunca coincide. */
const mismoCodigo = (a: string | null, b: string | null): boolean => {
  const x = normalizar(a).replace(/ /g, '');
  const y = normalizar(b).replace(/ /g, '');
  return x !== '' && x === y;
};
const mismosDigitos = (a: string | null, b: string | null): boolean => {
  const x = (a ?? '').replace(/\D/g, '');
  return x !== '' && x === (b ?? '').replace(/\D/g, '');
};
const dinero = (v: number | string | null): string | null =>
  v === null ? null : Number(v).toFixed(2);
const esImporteIgual = (
  esperado: string | null,
  leido: string | null,
  tolerancia: number,
): boolean => {
  if (!esperado?.trim() || !leido?.trim()) return false;
  const e = Number(esperado);
  const l = Number(leido);
  return (
    Number.isFinite(e) &&
    Number.isFinite(l) &&
    (e === 0 ? l === 0 : (Math.abs(l - e) / Math.abs(e)) * 100 <= tolerancia)
  );
};
const coincideDestinatario = (
  esperado: string | null,
  leido: string | null,
): boolean => {
  const e = normalizar(esperado);
  const l = normalizar(leido);
  if (!e || !l) return false;
  // Cada palabra distintiva del nombre más corto aparece (o abreviada) en el otro:
  // «La Segunda Coop. Ltda.» = «La Segunda Cooperativa»; «Posadas» = «Municipalidad de Posadas».
  const [corto, largo] =
    distintivas(e).length <= distintivas(l).length
      ? [distintivas(e), distintivas(l)]
      : [distintivas(l), distintivas(e)];
  if (corto.length === 0) return e === l;
  if (!corto.some((t) => t.length >= 5)) return e === l;
  return corto.every((t) =>
    largo.some((u) => u.startsWith(t) || t.startsWith(u)),
  );
};
const fechaArgentina = (fecha: string | null): string | null => {
  if (!fecha) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const instante = new Date(fecha);
  if (Number.isNaN(instante.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(instante);
};
/** La fecha de hoy (AAAA-MM-DD) en la hora de la Argentina. */
const hoyEnArgentina = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
const dias = (a: string | null, b: string | null): number =>
  !a || !b
    ? Infinity
    : Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
      86_400_000;

@Injectable()
export class DocumentReconciliationService {
  private readonly logger = new Logger(DocumentReconciliationService.name);
  constructor(
    @InjectRepository(Attachment)
    private readonly attachments: Repository<Attachment>,
    @InjectRepository(InsuranceInstallment)
    private readonly installments: Repository<InsuranceInstallment>,
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    @InjectRepository(InsurancePolicy)
    private readonly policies: Repository<InsurancePolicy>,
    @InjectRepository(Car) private readonly cars: Repository<Car>,
    @InjectRepository(PurchaseReceipt)
    private readonly receipts: Repository<PurchaseReceipt>,
    @InjectRepository(PurchaseOrder)
    private readonly orders: Repository<PurchaseOrder>,
    @InjectRepository(Supplier)
    private readonly suppliers: Repository<Supplier>,
    @InjectRepository(Employee)
    private readonly employees: Repository<Employee>,
    private readonly settings: DocumentReadingSettingsService,
    private readonly events: EventEmitter2,
  ) {}

  async conciliar(reading: DocumentReading): Promise<DocumentProposal | null> {
    const attachment = await this.attachments.findOne({
      where: {
        attachmentId: reading.attachmentId,
        distributorId: reading.distributorId,
      },
      withDeleted: true,
    });
    if (!attachment) return null;
    if (!this.tieneConciliador(attachment.ownerType)) return null;
    const parametros = await this.settings.parametros(reading.distributorId);
    if (!this.tipoCorrecto(attachment.ownerType, reading.detectedType))
      return this.review(attachment, 'El documento no es lo que se esperaba.');
    switch (attachment.ownerType) {
      case AttachmentOwnerType.INSURANCE_INSTALLMENT:
        return this.cuota(reading, attachment, parametros.amountTolerancePct);
      case AttachmentOwnerType.TRAFFIC_FINE_PAYMENT:
        return this.multa(reading, attachment, parametros.amountTolerancePct);
      case AttachmentOwnerType.INSURANCE_POLICY:
        return this.poliza(reading, attachment, parametros.dateToleranceDays);
      case AttachmentOwnerType.PURCHASE_RECEIPT:
        return this.compra(reading, attachment, parametros.amountTolerancePct);
      case AttachmentOwnerType.EMPLOYEE:
        return this.empleado(reading, attachment);
      default:
        return null;
    }
  }
  private tieneConciliador(owner: AttachmentOwnerType): boolean {
    return [
      AttachmentOwnerType.INSURANCE_INSTALLMENT,
      AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
      AttachmentOwnerType.INSURANCE_POLICY,
      AttachmentOwnerType.PURCHASE_RECEIPT,
      AttachmentOwnerType.EMPLOYEE,
    ].includes(owner);
  }

  private tipoCorrecto(
    owner: AttachmentOwnerType,
    tipo: TipoDeDocumento | null,
  ): boolean {
    if (!tipo) return false;
    if (owner === AttachmentOwnerType.INSURANCE_POLICY)
      return tipo === TipoDeDocumento.POLIZA;
    if (owner === AttachmentOwnerType.PURCHASE_RECEIPT)
      return tipo === TipoDeDocumento.FACTURA_O_REMITO;
    if (owner === AttachmentOwnerType.EMPLOYEE)
      return [
        TipoDeDocumento.LICENCIA_DE_CONDUCIR,
        TipoDeDocumento.APTO_MEDICO,
      ].includes(tipo);
    return tipo === TipoDeDocumento.COMPROBANTE_DE_PAGO;
  }
  private base(
    action: DocumentProposalAction,
    a: Attachment,
    expected: Valores,
    read: Valores,
    differences: DocumentProposal['differences'],
    summary: string,
  ): DocumentProposal {
    return {
      action,
      ownerType: a.ownerType,
      ownerId: a.ownerId,
      expected,
      read,
      differences,
      summary,
    };
  }
  private diferencia(
    list: DocumentProposal['differences'],
    field: string,
    expected: string | null,
    read: string | null,
    message: string,
  ): void {
    list.push({ field, expected, read, message });
  }
  private review(a: Attachment, message: string): DocumentProposal {
    return this.base(
      'review',
      a,
      {},
      {},
      [{ field: 'documento', expected: null, read: null, message }],
      message,
    );
  }

  private async cuota(
    r: DocumentReading,
    a: Attachment,
    tolerance: number,
  ): Promise<DocumentProposal | null> {
    const cuota = await this.installments.findOne({
      where: { installmentId: a.ownerId, distributorId: r.distributorId },
      relations: { policy: { insurer: true } },
      withDeleted: true,
    });
    if (!cuota) return this.review(a, 'No se encontró la cuota para conciliar');
    // Es el comprobante del pago ya registrado (su escaneo al subirlo no llegó
    // y la cola lo leyó después): no hay nada que proponer ni avisar.
    if (
      cuota.status === InstallmentStatus.PAID &&
      cuota.receiptAttachmentId === a.attachmentId
    )
      return null;
    if (cuota.status === InstallmentStatus.CANCELLED)
      return this.review(a, 'La cuota está cancelada: revisá el comprobante');
    if (cuota.status === InstallmentStatus.PAID) {
      pedirAvisoAlAdmin(this.events, this.logger, {
        distributorId: r.distributorId,
        kind: 'document_reading_notice',
        title: 'La cuota ya figura pagada',
        body: 'El comprobante se revisó, pero la cuota ya figura pagada.',
        link: { entity: 'document-reading', id: r.readingId },
        dedupeKey: `document-reading:${r.readingId}:cuota-pagada`,
      });
      return null;
    }
    const expected = {
      importe: dinero(cuota.amount),
      destinatario: cuota.policy?.insurer?.name ?? null,
      // Se puede pagar desde que empieza la vigencia de la póliza: antes del
      // vencimiento de la cuota también vale.
      pagable_desde: cuota.policy?.validFrom ?? null,
    };
    const read = {
      importe: valor(r, 'importe'),
      destinatario: valor(r, 'destinatario'),
      fecha_de_pago: valor(r, 'fecha_de_pago'),
    };
    const d: DocumentProposal['differences'] = [];
    if (!esImporteIgual(expected.importe, read.importe, tolerance))
      this.diferencia(
        d,
        'importe',
        expected.importe,
        read.importe,
        'El importe del comprobante difiere del esperado',
      );
    if (
      expected.destinatario &&
      !coincideDestinatario(expected.destinatario, read.destinatario)
    )
      this.diferencia(
        d,
        'destinatario',
        expected.destinatario,
        read.destinatario,
        'El destinatario no coincide con la aseguradora',
      );
    const pago = fechaArgentina(read.fecha_de_pago);
    if (
      !pago ||
      pago > hoyEnArgentina() ||
      (expected.pagable_desde !== null && pago < expected.pagable_desde)
    )
      this.diferencia(
        d,
        'fecha_de_pago',
        expected.pagable_desde,
        read.fecha_de_pago,
        pago
          ? 'La fecha de pago es futura o anterior a la vigencia de la póliza'
          : 'El comprobante no informa la fecha de pago',
      );
    return this.base(
      'pay_installment',
      a,
      expected,
      read,
      d,
      d.length
        ? 'Revisá las diferencias del comprobante de la cuota.'
        : 'Comprobante de cuota listo para confirmar.',
    );
  }

  private async multa(
    r: DocumentReading,
    a: Attachment,
    tolerance: number,
  ): Promise<DocumentProposal | null> {
    const fine = await this.fines.findOne({
      where: { fineId: a.ownerId, distributorId: r.distributorId },
      withDeleted: true,
    });
    if (!fine) return this.review(a, 'No se encontró la multa para conciliar');
    if (fine.status === TrafficFineStatus.PAID)
      return fine.receiptAttachmentId === a.attachmentId
        ? null
        : this.review(a, 'La multa ya figura pagada: revisá el comprobante');
    if (fine.status === TrafficFineStatus.VOIDED)
      return this.review(a, 'La multa está anulada: revisá el comprobante');
    const expected = {
      importe: importeEsperadoDeLaMulta(fine),
      destinatario: fine.jurisdiction,
    };
    const read = {
      importe: valor(r, 'importe'),
      destinatario: valor(r, 'destinatario'),
    };
    const d: DocumentProposal['differences'] = [];
    if (!esImporteIgual(expected.importe, read.importe, tolerance))
      this.diferencia(
        d,
        'importe',
        expected.importe,
        read.importe,
        'El importe del comprobante difiere del esperado',
      );
    if (!coincideDestinatario(expected.destinatario, read.destinatario))
      this.diferencia(
        d,
        'destinatario',
        expected.destinatario,
        read.destinatario,
        'El destinatario no coincide con la jurisdicción',
      );
    return this.base(
      'pay_fine',
      a,
      expected,
      read,
      d,
      d.length
        ? 'Revisá las diferencias del comprobante de la multa.'
        : 'Comprobante de multa listo para confirmar.',
    );
  }

  private async poliza(
    r: DocumentReading,
    a: Attachment,
    tolerance: number,
  ): Promise<DocumentProposal | null> {
    const policy = await this.policies.findOne({
      where: { policyId: a.ownerId, distributorId: r.distributorId },
      withDeleted: true,
    });
    if (!policy)
      return this.review(a, 'No se encontró la póliza para conciliar');
    const car = await this.cars.findOne({
      where: { carId: policy.carId, distributorId: r.distributorId },
      withDeleted: true,
    });
    const expected = {
      patente: car?.carPatent ?? null,
      numero_de_poliza: policy.policyNumber,
      vigencia_desde: policy.validFrom,
      vigencia_hasta: policy.validTo,
    };
    const read = {
      patente: valor(r, 'patente'),
      numero_de_poliza: valor(r, 'numero_de_poliza'),
      vigencia_desde: valor(r, 'vigencia_desde'),
      vigencia_hasta: valor(r, 'vigencia_hasta'),
    };
    const d: DocumentProposal['differences'] = [];
    for (const key of ['patente', 'numero_de_poliza'] as const)
      if (!mismoCodigo(expected[key], read[key]))
        this.diferencia(
          d,
          key,
          expected[key],
          read[key],
          key === 'patente'
            ? 'La patente no coincide con el vehículo de la póliza'
            : 'El número de póliza no coincide',
        );
    for (const key of ['vigencia_desde', 'vigencia_hasta'] as const)
      if (dias(expected[key], read[key]) > tolerance)
        this.diferencia(
          d,
          key,
          expected[key],
          read[key],
          'La vigencia difiere de la póliza registrada',
        );
    return this.base(
      'update_policy',
      a,
      expected,
      read,
      d,
      d.length
        ? 'Revisá las diferencias de la póliza.'
        : 'Póliza lista para confirmar.',
    );
  }

  private async compra(
    r: DocumentReading,
    a: Attachment,
    tolerance: number,
  ): Promise<DocumentProposal | null> {
    const receipt = await this.receipts.findOne({
      where: { receiptId: a.ownerId, distributorId: r.distributorId },
      withDeleted: true,
    });
    if (!receipt)
      return this.review(a, 'No se encontró la recepción para conciliar');
    const supplier = await this.suppliers.findOne({
      where: { supplierId: receipt.supplierId, distributorId: r.distributorId },
      withDeleted: true,
    });
    const order = receipt.purchaseOrderId
      ? await this.orders.findOne({
          where: {
            purchaseOrderId: receipt.purchaseOrderId,
            distributorId: r.distributorId,
          },
          withDeleted: true,
        })
      : null;
    const expected = {
      cuit_del_emisor: supplier?.cuit ?? null,
      total: dinero(receipt.totalAmount || order?.totalAmount || null),
    };
    const read = {
      cuit_del_emisor: valor(r, 'cuit_del_emisor'),
      total: valor(r, 'total'),
    };
    const d: DocumentProposal['differences'] = [];
    if (!mismosDigitos(expected.cuit_del_emisor, read.cuit_del_emisor))
      this.diferencia(
        d,
        'cuit_del_emisor',
        expected.cuit_del_emisor,
        read.cuit_del_emisor,
        'El CUIT no coincide con el proveedor',
      );
    if (!esImporteIgual(expected.total, read.total, tolerance))
      this.diferencia(
        d,
        'total',
        expected.total,
        read.total,
        'El total no coincide con la recepción u orden de compra',
      );
    return this.base(
      'register_purchase_invoice',
      a,
      expected,
      read,
      d,
      d.length
        ? 'Revisá las diferencias de la factura de compra.'
        : 'Factura de compra lista para confirmar.',
    );
  }

  private async empleado(
    r: DocumentReading,
    a: Attachment,
  ): Promise<DocumentProposal | null> {
    const employee = await this.employees.findOne({
      where: { employeeId: a.ownerId, distributorId: r.distributorId },
      withDeleted: true,
    });
    if (!employee)
      return this.review(a, 'No se encontró el legajo para conciliar');
    const expected = {
      documento: employee.documentNumber,
      titular: `${employee.firstName} ${employee.lastName}`,
    };
    const read = {
      documento: valor(r, 'documento'),
      titular: valor(r, 'titular'),
      vencimiento: valor(r, 'vencimiento'),
    };
    const d: DocumentProposal['differences'] = [];
    if (!mismosDigitos(expected.documento, read.documento))
      this.diferencia(
        d,
        'documento',
        expected.documento,
        read.documento,
        'El documento no coincide con el legajo',
      );
    return this.base(
      'update_employee_document',
      a,
      expected,
      read,
      d,
      [
        d.length
          ? 'Revisá los datos del documento del personal.'
          : 'Documento del personal listo para confirmar.',
        read.vencimiento
          ? `Trae vencimiento ${read.vencimiento} para actualizar.`
          : '',
      ]
        .join(' ')
        .trim(),
    );
  }
}
