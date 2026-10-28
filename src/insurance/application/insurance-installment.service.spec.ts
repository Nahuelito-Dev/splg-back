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
import { InstallmentStatus } from '../domain/insurance.enums';
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
