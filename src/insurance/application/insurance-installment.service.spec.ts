import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AttachmentService } from '../../attachment/attachment.service';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { CashDocumentPaymentService } from '../../cash/application/cash-document-payment.service';
import {
  CashBoxKind,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import { diaArgentino, sumarDias } from '../../common/utils/dias-argentina';
import { RoleType } from '../../common/constants/role-type.enum';
import {
  DatosDelComprobante,
  ReceiptReaderPort,
} from '../../receipt-reader/receipt-reader.port';
import {
  InstallmentApprovalStatus,
  InstallmentStatus,
} from '../domain/insurance.enums';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import {
  ETIQUETA_COMPROBANTE_DE_CUOTA,
  InsuranceInstallmentService,
  TOPE_DEL_ESCANEO_MS,
} from './insurance-installment.service';

const ACTOR = { userId: 'u1', role: RoleType.ADMIN };
const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

function archivo(mimetype = 'image/png'): Express.Multer.File {
  return { mimetype, buffer: PNG, size: PNG.length } as Express.Multer.File;
}

describe('InsuranceInstallmentService', () => {
  let service: InsuranceInstallmentService;
  let repo: { findOne: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    save: jest.Mock;
  };
  let attachments: { upload: jest.Mock; findDelDueno: jest.Mock };
  let pagos: {
    cajaDelPago: jest.Mock;
    egresar: jest.Mock;
    medioDeLaCaja: jest.Mock;
  };
  let lector: { disponible: boolean; leer: jest.Mock };
  let cuota: InsuranceInstallment;

  const cuotaBase = (over: Partial<InsuranceInstallment> = {}) =>
    ({
      installmentId: 'q5',
      distributorId: 'd1',
      policyId: 'p1',
      number: 5,
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
      approvalStatus: InstallmentApprovalStatus.NONE,
      approvalRequestedAt: null,
      approvedAt: null,
      approvedByUserId: null,
      policy: { insurer: { name: 'Seguros Rivadavia' } },
      ...over,
    }) as unknown as InsuranceInstallment;

  const poliza = {
    policyId: 'p1',
    carId: 'c1',
    car: { carPatent: 'OVQ621' },
    insurer: { name: 'Seguros Rivadavia' },
  } as unknown as InsurancePolicy;

  beforeEach(() => {
    cuota = cuotaBase();
    repo = { findOne: jest.fn().mockResolvedValue(cuota) };
    manager = {
      findOne: jest.fn((entidad: unknown) =>
        Promise.resolve(entidad === InsuranceInstallment ? cuota : null),
      ),
      findOneOrFail: jest.fn().mockResolvedValue(poliza),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    attachments = {
      upload: jest.fn().mockResolvedValue({
        attachmentId: 'a1',
        mimeType: 'image/png',
      }),
      findDelDueno: jest
        .fn()
        .mockResolvedValue({ attachmentId: 'a1', mimeType: 'image/png' }),
    };
    pagos = {
      cajaDelPago: jest.fn().mockResolvedValue('caja1'),
      egresar: jest.fn().mockResolvedValue({ movementId: 'mov1' }),
      medioDeLaCaja: jest.fn().mockResolvedValue(CashMethod.TRANSFER),
    };
    lector = { disponible: false, leer: jest.fn() };
    service = new InsuranceInstallmentService(
      repo as unknown as Repository<InsuranceInstallment>,
      dataSource as unknown as DataSource,
      attachments as unknown as AttachmentService,
      pagos as unknown as CashDocumentPaymentService,
      lector as unknown as ReceiptReaderPort,
    );
  });

  describe('subirComprobante', () => {
    it('sin lector configurado la subida vale y los datos se cargan a mano', async () => {
      const r = await service.subirComprobante('q5', archivo(), 'd1', ACTOR);

      expect(attachments.upload).toHaveBeenCalledWith(
        AttachmentOwnerType.INSURANCE_INSTALLMENT,
        'q5',
        'd1',
        expect.anything(),
        ETIQUETA_COMPROBANTE_DE_CUOTA,
        ACTOR,
      );
      expect(r).toEqual({
        attachmentId: 'a1',
        scan: { available: false, data: null },
      });
      expect(lector.leer).not.toHaveBeenCalled();
    });

    it('con lector escanea apenas se sube, con el importe y la aseguradora como pistas', async () => {
      const leido: DatosDelComprobante = {
        amount: '29958.00',
        paidAt: '2026-10-20T14:30:00-03:00',
        operationNumber: '88123456',
        payee: 'Seguros Rivadavia',
        payeeTaxId: null,
        period: '2026-11',
        confidence: 'high',
        warnings: [],
      };
      lector.disponible = true;
      lector.leer.mockResolvedValue(leido);

      const r = await service.subirComprobante('q5', archivo(), 'd1', ACTOR);

      expect(lector.leer).toHaveBeenCalledWith(
        { buffer: PNG, mimeType: 'image/png' },
        { expectedAmount: '29958.00', payee: 'Seguros Rivadavia' },
        expect.objectContaining({
          distributorId: 'd1',
          attachmentId: expect.any(String) as string,
        }),
      );
      expect(r.scan).toEqual({ available: true, data: leido });
    });

    it('un escaneo que falla nunca rompe la subida', async () => {
      lector.disponible = true;
      lector.leer.mockRejectedValue(new Error('el modelo no respondió'));

      const r = await service.subirComprobante('q5', archivo(), 'd1', ACTOR);

      expect(r).toEqual({
        attachmentId: 'a1',
        scan: {
          available: true,
          data: null,
          warning: expect.stringContaining('No se pudo leer') as string,
        },
      });
    });

    it('un lector colgado se corta a los 30 s: la subida responde available:true, data null y un aviso', async () => {
      jest.useFakeTimers();
      try {
        lector.disponible = true;
        lector.leer.mockReturnValue(new Promise(() => undefined));

        const pendiente = service.subirComprobante(
          'q5',
          archivo(),
          'd1',
          ACTOR,
        );
        await jest.advanceTimersByTimeAsync(TOPE_DEL_ESCANEO_MS);
        const r = await pendiente;

        expect(r.attachmentId).toBe('a1');
        expect(r.scan).toMatchObject({ available: true, data: null });
        expect(r.scan.warning).toMatch(/tardó demasiado/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('un lector que contesta a tiempo no deja el temporizador pendiente', async () => {
      jest.useFakeTimers();
      try {
        lector.disponible = true;
        lector.leer.mockResolvedValue(null);
        await service.subirComprobante('q5', archivo(), 'd1', ACTOR);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('lo que el lector no pudo leer queda como data null', async () => {
      lector.disponible = true;
      lector.leer.mockResolvedValue(null);
      const r = await service.subirComprobante('q5', archivo(), 'd1', ACTOR);
      expect(r.scan).toEqual({ available: true, data: null });
    });

    it('una cuota de otra distribuidora es 404 y no sube nada', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.subirComprobante('q5', archivo(), 'd2', ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { installmentId: 'q5', distributorId: 'd2' },
        }),
      );
      expect(attachments.upload).not.toHaveBeenCalled();
    });

    it.each([InstallmentStatus.PAID, InstallmentStatus.CANCELLED])(
      'una cuota %s no admite un comprobante nuevo (409)',
      async (status) => {
        repo.findOne.mockResolvedValue(cuotaBase({ status }));
        await expect(
          service.subirComprobante('q5', archivo(), 'd1', ACTOR),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(attachments.upload).not.toHaveBeenCalled();
      },
    );

    it('sólo PDF o imagen: un Word es 415', async () => {
      await expect(
        service.subirComprobante(
          'q5',
          archivo(
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
          'd1',
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(attachments.upload).not.toHaveBeenCalled();
    });
  });

  describe('pagar', () => {
    const dto = {
      attachmentId: 'a1',
      paidAt: '2026-10-20T14:30:00-03:00',
      amount: 29958,
      operationNumber: '88123456',
      cashBoxId: 'caja1',
    };

    // Todo pago requiere aprobación: salvo que el test diga otra cosa, la cuota ya está aprobada.
    beforeEach(() => {
      cuota.approvalStatus = InstallmentApprovalStatus.APPROVED;
      cuota.approvalRequestedAt = new Date('2026-10-18T12:00:00Z');
      cuota.approvedAt = new Date('2026-10-19T12:00:00Z');
      cuota.approvedByUserId = 'u9';
    });

    it('saca el egreso de la caja elegida con la categoría y la referencia de la cuota y la deja paga', async () => {
      await service.pagar('q5', dto, 'd1', 'u1');

      expect(pagos.cajaDelPago).toHaveBeenCalledWith(manager, 'd1', 'caja1', [
        CashBoxKind.CASH,
        CashBoxKind.BANK,
        CashBoxKind.WALLET,
      ]);
      expect(pagos.egresar).toHaveBeenCalledWith(manager, {
        distributorId: 'd1',
        cashBoxId: 'caja1',
        amount: 29958,
        systemCode: CashSystemCode.INSURANCE,
        referenceType: CashReferenceType.INSURANCE_INSTALLMENT,
        referenceId: 'q5',
        description: 'Seguro OVQ621 — Seguros Rivadavia, cuota 5/6',
        userId: 'u1',
        method: CashMethod.TRANSFER,
      });
      expect(cuota).toMatchObject({
        status: InstallmentStatus.PAID,
        paidAt: new Date('2026-10-20T17:30:00.000Z'),
        paidAmount: 29958,
        operationNumber: '88123456',
        paidByUserId: 'u1',
        cashMovementId: 'mov1',
        receiptAttachmentId: 'a1',
      });
      expect(manager.save).toHaveBeenCalledWith(cuota);
    });

    it.each([
      [CashMethod.CASH],
      [CashMethod.TRANSFER],
      [CashMethod.MERCADOPAGO],
    ])('el medio del egreso sigue a la clase de caja (%s)', async (medio) => {
      pagos.medioDeLaCaja.mockResolvedValue(medio);
      await service.pagar('q5', dto, 'd1', 'u1');
      expect(pagos.egresar).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ method: medio }),
      );
    });

    it('bloquea la cuota de la distribuidora y valida que el comprobante sea de esa cuota', async () => {
      await service.pagar('q5', dto, 'd1', 'u1');
      expect(manager.findOne).toHaveBeenCalledWith(InsuranceInstallment, {
        where: { installmentId: 'q5', distributorId: 'd1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(attachments.findDelDueno).toHaveBeenCalledWith(
        manager,
        'a1',
        AttachmentOwnerType.INSURANCE_INSTALLMENT,
        'q5',
        'd1',
      );
    });

    it('una fecha sin hora es ese día en hora argentina, no medianoche UTC', async () => {
      await service.pagar('q5', { ...dto, paidAt: '2026-10-20' }, 'd1', 'u1');
      expect(cuota.paidAt).toEqual(new Date('2026-10-20T03:00:00.000Z'));
    });

    it('«hoy» sin hora no es futuro, «mañana» sí', async () => {
      await service.pagar('q5', { ...dto, paidAt: diaArgentino() }, 'd1', 'u1');
      expect(cuota.status).toBe(InstallmentStatus.PAID);
      cuota.status = InstallmentStatus.PENDING;
      await expect(
        service.pagar(
          'q5',
          { ...dto, paidAt: sumarDias(diaArgentino(), 1) },
          'd1',
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un comprobante que no es PDF ni imagen es 400 y no mueve la caja', async () => {
      attachments.findDelDueno.mockResolvedValue({
        attachmentId: 'a1',
        mimeType: 'text/csv',
      });
      await expect(service.pagar('q5', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('una cuota ya paga es 409 y no vuelve a sacar plata', async () => {
      cuota.status = InstallmentStatus.PAID;
      await expect(service.pagar('q5', dto, 'd1', 'u1')).rejects.toThrow(
        'La cuota ya está paga',
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('una cuota cancelada es 409', async () => {
      cuota.status = InstallmentStatus.CANCELLED;
      await expect(service.pagar('q5', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it.each([
      InstallmentApprovalStatus.AWAITING,
      InstallmentApprovalStatus.NONE,
    ])(
      'una cuota con la aprobación en %s no se paga: 409 INSTALLMENT_APPROVAL_REQUIRED y no mueve la caja',
      async (estado) => {
        cuota.approvalStatus = estado;
        cuota.approvedAt = null;
        cuota.approvedByUserId = null;
        await expect(
          service.pagar('q5', dto, 'd1', 'u1'),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'INSTALLMENT_APPROVAL_REQUIRED' },
        });
        expect(pagos.egresar).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it('no se paga más que el importe aprobado (409 INSTALLMENT_AMOUNT_EXCEEDS_APPROVED)', async () => {
      await expect(
        service.pagar('q5', { ...dto, amount: 29958.01 }, 'd1', 'u1'),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'INSTALLMENT_AMOUNT_EXCEEDS_APPROVED' },
      });
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('un importe menor al aprobado (descuento) se paga', async () => {
      await service.pagar('q5', { ...dto, amount: 29000 }, 'd1', 'u1');
      expect(pagos.egresar).toHaveBeenCalledTimes(1);
    });

    it('confirmar desde una lectura de documento cuenta como la aprobación de quien confirma, antes de pagar', async () => {
      cuota.approvalStatus = InstallmentApprovalStatus.NONE;
      cuota.approvalRequestedAt = null;
      cuota.approvedAt = null;
      cuota.approvedByUserId = null;

      await service.pagarEn(manager as never, 'q5', dto, 'd1', 'u7', true);

      expect(cuota).toMatchObject({
        approvalStatus: InstallmentApprovalStatus.APPROVED,
        approvedByUserId: 'u7',
        status: InstallmentStatus.PAID,
      });
      expect(cuota.approvedAt).toBeInstanceOf(Date);
      expect(cuota.approvalRequestedAt).toBeInstanceOf(Date);
      expect(pagos.egresar).toHaveBeenCalledTimes(1);
    });

    it('sin confirmar la aprobación, pagarEn tampoco paga una cuota sin aprobar', async () => {
      cuota.approvalStatus = InstallmentApprovalStatus.NONE;
      await expect(
        service.pagarEn(manager as never, 'q5', dto, 'd1', 'u7'),
      ).rejects.toMatchObject({ status: 409 });
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('una cuota aprobada se paga como siempre', async () => {
      cuota.approvalStatus = InstallmentApprovalStatus.APPROVED;
      await service.pagar('q5', dto, 'd1', 'u1');
      expect(pagos.egresar).toHaveBeenCalledTimes(1);
      expect(cuota.status).toBe(InstallmentStatus.PAID);
    });

    it('un comprobante de otra cuota es 400 y no mueve la caja', async () => {
      attachments.findDelDueno.mockResolvedValue(null);
      await expect(service.pagar('q5', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
      expect(cuota.status).toBe(InstallmentStatus.PENDING);
    });

    it('una cuota de otra distribuidora es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.pagar('q5', dto, 'd2', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('una fecha de pago futura es 400 y no abre la transacción', async () => {
      await expect(
        service.pagar('q5', { ...dto, paidAt: '2999-01-01' }, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('si la caja no admite el pago o no tiene saldo, la cuota queda pendiente', async () => {
      pagos.egresar.mockRejectedValue(
        new ConflictException('Saldo insuficiente'),
      );
      await expect(service.pagar('q5', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(cuota.status).toBe(InstallmentStatus.PENDING);
    });

    it('sin caja resuelta es 400', async () => {
      pagos.cajaDelPago.mockResolvedValue(null);
      await expect(service.pagar('q5', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('aprobar', () => {
    const AHORA = new Date('2026-11-18T12:00:00Z');

    it('aprueba la cuota pendiente de aprobación y deja quién y cuándo', async () => {
      cuota.approvalStatus = InstallmentApprovalStatus.AWAITING;
      cuota.approvalRequestedAt = new Date('2026-11-17T12:00:00Z');

      await service.aprobar('q5', 'd1', 'u9', AHORA);

      expect(cuota).toMatchObject({
        approvalStatus: InstallmentApprovalStatus.APPROVED,
        approvedAt: AHORA,
        approvedByUserId: 'u9',
        status: InstallmentStatus.PENDING,
      });
      expect(manager.save).toHaveBeenCalledWith(cuota);
      // Aprobar no mueve plata: el pago se registra aparte.
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('se aprueba también una cuota sin pedido de aprobación (todo pago requiere aprobación): deja el pedido y la aprobación', async () => {
      cuota.approvalStatus = InstallmentApprovalStatus.NONE;
      await service.aprobar('q5', 'd1', 'u9', AHORA);
      expect(cuota).toMatchObject({
        approvalStatus: InstallmentApprovalStatus.APPROVED,
        approvalRequestedAt: AHORA,
        approvedAt: AHORA,
        approvedByUserId: 'u9',
      });
    });

    it('una cuota ya aprobada es 409 INSTALLMENT_NOT_APPROVABLE y no cambia quién aprobó', async () => {
      cuota.approvalStatus = InstallmentApprovalStatus.APPROVED;
      cuota.approvedByUserId = 'u1';
      await expect(
        service.aprobar('q5', 'd1', 'u9', AHORA),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'INSTALLMENT_NOT_APPROVABLE',
          message: expect.stringContaining('ya está aprobada') as unknown,
        },
      });
      expect(cuota.approvedByUserId).toBe('u1');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it.each([InstallmentStatus.PAID, InstallmentStatus.CANCELLED])(
      'una cuota %s no se aprueba (409)',
      async (status) => {
        cuota.status = status;
        cuota.approvalStatus = InstallmentApprovalStatus.AWAITING;
        await expect(
          service.aprobar('q5', 'd1', 'u9', AHORA),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it('una cuota de otra distribuidora es 404 (bloquea con el tenant)', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.aprobar('q5', 'd2', 'u9', AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.findOne).toHaveBeenCalledWith(
        InsuranceInstallment,
        expect.objectContaining({
          where: { installmentId: 'q5', distributorId: 'd2' },
        }),
      );
    });
  });

  describe('modificar', () => {
    it('corrige importe y vencimiento de una cuota pendiente', async () => {
      await service.modificar(
        'q5',
        { amount: 31000, dueDate: '2026-11-25', graceUntil: '2026-11-30' },
        'd1',
      );
      expect(cuota).toMatchObject({
        amount: 31000,
        dueDate: '2026-11-25',
        graceUntil: '2026-11-30',
      });
      expect(manager.save).toHaveBeenCalledWith(cuota);
    });

    it('si sólo se mueve el vencimiento, la gracia se corre con él conservando sus días', async () => {
      manager.findOneOrFail.mockResolvedValue({
        validFrom: '2026-06-22',
        validTo: '2027-06-22',
      });
      await service.modificar('q5', { dueDate: '2026-11-30' }, 'd1');
      expect(cuota).toMatchObject({
        dueDate: '2026-11-30',
        graceUntil: '2026-12-05',
      });
    });

    it('si viene también la gracia, se respeta la que vino', async () => {
      manager.findOneOrFail.mockResolvedValue({
        validFrom: '2026-06-22',
        validTo: '2027-06-22',
      });
      await service.modificar(
        'q5',
        { dueDate: '2026-11-30', graceUntil: '2026-12-31' },
        'd1',
      );
      expect(cuota.graceUntil).toBe('2026-12-31');
    });

    it.each(['2026-06-21', '2027-06-23'])(
      'un vencimiento fuera de la vigencia de la póliza (%s) es 400',
      async (dueDate) => {
        manager.findOneOrFail.mockResolvedValue({
          validFrom: '2026-06-22',
          validTo: '2027-06-22',
        });
        await expect(
          service.modificar('q5', { dueDate }, 'd1'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it('la gracia no puede quedar antes del vencimiento (400)', async () => {
      await expect(
        service.modificar('q5', { graceUntil: '2026-11-01' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    describe('una cuota aprobada vuelve a pedir aprobación si cambia lo aprobado', () => {
      const AHORA = new Date('2026-11-18T12:00:00Z');
      beforeEach(() => {
        cuota.approvalStatus = InstallmentApprovalStatus.APPROVED;
        cuota.approvalRequestedAt = new Date('2026-11-10T12:00:00Z');
        cuota.approvedAt = new Date('2026-11-11T12:00:00Z');
        cuota.approvedByUserId = 'u9';
      });

      it.each([
        ['el importe', { amount: 31000 }],
        ['el vencimiento', { dueDate: '2026-11-25' }],
      ])('al corregir %s', async (_n, cambio) => {
        await service.modificar('q5', cambio, 'd1', AHORA);
        expect(cuota).toMatchObject({
          approvalStatus: InstallmentApprovalStatus.AWAITING,
          approvalRequestedAt: AHORA,
          approvedAt: null,
          approvedByUserId: null,
        });
        expect(manager.save).toHaveBeenCalledWith(cuota);
      });

      it('corregir sólo la gracia, o repetir el mismo importe, no toca la aprobación', async () => {
        await service.modificar(
          'q5',
          { graceUntil: '2026-11-30', amount: cuota.amount },
          'd1',
          AHORA,
        );
        expect(cuota.approvalStatus).toBe(InstallmentApprovalStatus.APPROVED);
        expect(cuota.approvedByUserId).toBe('u9');
      });
    });

    it('una cuota paga no se corrige (409)', async () => {
      cuota.status = InstallmentStatus.PAID;
      await expect(
        service.modificar('q5', { amount: 1 }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('findOne de otra distribuidora es 404', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findOne('q5', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
