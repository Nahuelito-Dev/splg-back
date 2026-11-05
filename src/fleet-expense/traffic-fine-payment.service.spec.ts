import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AttachmentService } from '../attachment/attachment.service';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import {
  CashBoxKind,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../cash/domain/cash.enums';
import { RoleType } from '../common/constants/role-type.enum';
import { diaArgentino, sumarDias } from '../common/utils/dias-argentina';
import {
  DatosDelComprobante,
  ReceiptReaderPort,
} from '../receipt-reader/receipt-reader.port';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';
import {
  ETIQUETA_COMPROBANTE_DE_MULTA,
  TOPE_DEL_ESCANEO_MS,
  TrafficFinePaymentService,
} from './traffic-fine-payment.service';
import { TrafficFineService } from './traffic-fine.service';

const ACTOR = { userId: 'u1', role: RoleType.ADMIN };
const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

function archivo(mimetype = 'image/png'): Express.Multer.File {
  return { mimetype, buffer: PNG, size: PNG.length } as Express.Multer.File;
}

describe('TrafficFinePaymentService (F15)', () => {
  let service: TrafficFinePaymentService;
  let multas: { findOne: jest.Mock };
  let manager: { findOne: jest.Mock; save: jest.Mock };
  let attachments: { upload: jest.Mock; findDelDueno: jest.Mock };
  let pagos: {
    cajaDelPago: jest.Mock;
    egresar: jest.Mock;
    medioDeLaCaja: jest.Mock;
  };
  let lector: { disponible: boolean; leer: jest.Mock };
  let multa: TrafficFine;

  const multaBase = (over: Partial<TrafficFine> = {}) =>
    ({
      fineId: 'm1',
      distributorId: 'd1',
      carId: 'c1',
      car: { carPatent: 'AB123CD' },
      occurredAt: new Date('2026-09-01T15:00:00.000Z'),
      jurisdiction: 'Municipalidad de Posadas',
      actNumber: 'A-0012345',
      amount: 85000,
      voluntaryPaymentAmount: 59500,
      dueDate: null,
      status: TrafficFineStatus.PENDING,
      paidAt: null,
      paidAmount: null,
      operationNumber: null,
      cashMovementId: null,
      receiptAttachmentId: null,
      ...over,
    }) as unknown as TrafficFine;

  beforeEach(() => {
    multa = multaBase();
    multas = { findOne: jest.fn().mockResolvedValue(multa) };
    manager = {
      findOne: jest.fn().mockImplementation(() => Promise.resolve(multa)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    attachments = {
      upload: jest
        .fn()
        .mockResolvedValue({ attachmentId: 'a1', mimeType: 'image/png' }),
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
    service = new TrafficFinePaymentService(
      dataSource as unknown as DataSource,
      multas as unknown as TrafficFineService,
      attachments as unknown as AttachmentService,
      pagos as unknown as CashDocumentPaymentService,
      lector as unknown as ReceiptReaderPort,
    );
  });

  describe('subirComprobante', () => {
    it('sin lector la subida vale y los datos se cargan a mano', async () => {
      const r = await service.subirComprobante('m1', archivo(), 'd1', ACTOR);
      expect(attachments.upload).toHaveBeenCalledWith(
        AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
        'm1',
        'd1',
        expect.anything(),
        ETIQUETA_COMPROBANTE_DE_MULTA,
        ACTOR,
      );
      expect(r).toEqual({
        attachmentId: 'a1',
        scan: { available: false, data: null },
      });
      expect(lector.leer).not.toHaveBeenCalled();
    });

    it('con lector escanea al subir: el voluntario como importe esperado y la jurisdicción como beneficiario', async () => {
      const leido: DatosDelComprobante = {
        amount: '59500.00',
        paidAt: '2026-10-20T14:30:00-03:00',
        operationNumber: '88123456',
        payee: 'Municipalidad de Posadas',
        payeeTaxId: null,
        period: null,
        confidence: 'high',
        warnings: [],
      };
      lector.disponible = true;
      lector.leer.mockResolvedValue(leido);
      const r = await service.subirComprobante('m1', archivo(), 'd1', ACTOR);
      expect(lector.leer).toHaveBeenCalledWith(
        { buffer: PNG, mimeType: 'image/png' },
        { expectedAmount: '59500.00', payee: 'Municipalidad de Posadas' },
        expect.objectContaining({
          distributorId: 'd1',
          attachmentId: expect.any(String) as string,
        }),
      );
      expect(r.scan).toEqual({ available: true, data: leido });
    });

    it('con el voluntario vencido la pista es el importe de la multa', async () => {
      multas.findOne.mockResolvedValue(
        multaBase({ dueDate: sumarDias(diaArgentino(), -2) }),
      );
      lector.disponible = true;
      lector.leer.mockResolvedValue(null);
      await service.subirComprobante('m1', archivo(), 'd1', ACTOR);
      expect(lector.leer).toHaveBeenCalledWith(
        expect.anything(),
        {
          expectedAmount: '85000.00',
          payee: 'Municipalidad de Posadas',
        },
        expect.objectContaining({
          distributorId: 'd1',
          attachmentId: expect.any(String) as string,
        }),
      );
    });

    it('sin voluntario la pista es el importe de la multa', async () => {
      multas.findOne.mockResolvedValue(
        multaBase({ voluntaryPaymentAmount: null }),
      );
      lector.disponible = true;
      lector.leer.mockResolvedValue(null);
      await service.subirComprobante('m1', archivo(), 'd1', ACTOR);
      expect(lector.leer).toHaveBeenCalledWith(
        expect.anything(),
        {
          expectedAmount: '85000.00',
          payee: 'Municipalidad de Posadas',
        },
        expect.objectContaining({
          distributorId: 'd1',
          attachmentId: expect.any(String) as string,
        }),
      );
    });

    it('un escaneo que falla nunca rompe la subida', async () => {
      lector.disponible = true;
      lector.leer.mockRejectedValue(new Error('el modelo no respondió'));
      const r = await service.subirComprobante('m1', archivo(), 'd1', ACTOR);
      expect(r.attachmentId).toBe('a1');
      expect(r.scan).toMatchObject({ available: true, data: null });
      expect(r.scan.warning).toMatch(/No se pudo leer/);
    });

    it('un lector colgado se corta a los 30 s', async () => {
      jest.useFakeTimers();
      try {
        lector.disponible = true;
        lector.leer.mockReturnValue(new Promise(() => undefined));
        const pendiente = service.subirComprobante(
          'm1',
          archivo(),
          'd1',
          ACTOR,
        );
        await jest.advanceTimersByTimeAsync(TOPE_DEL_ESCANEO_MS);
        const r = await pendiente;
        expect(r.scan).toMatchObject({ available: true, data: null });
        expect(r.scan.warning).toMatch(/tardó demasiado/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('una multa de otra distribuidora es 404 y no sube nada', async () => {
      multas.findOne.mockRejectedValue(new NotFoundException('Multa m1'));
      await expect(
        service.subirComprobante('m1', archivo(), 'd2', ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(multas.findOne).toHaveBeenCalledWith('m1', 'd2');
      expect(attachments.upload).not.toHaveBeenCalled();
    });

    it.each([TrafficFineStatus.PAID, TrafficFineStatus.VOIDED])(
      'una multa %s no admite un comprobante nuevo (409)',
      async (status) => {
        multas.findOne.mockResolvedValue(multaBase({ status }));
        await expect(
          service.subirComprobante('m1', archivo(), 'd1', ACTOR),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(attachments.upload).not.toHaveBeenCalled();
      },
    );

    it('sólo PDF o imagen: un Word es 415', async () => {
      await expect(
        service.subirComprobante(
          'm1',
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
      amount: 59500,
      operationNumber: '88123456',
      cashBoxId: 'caja1',
    };

    it('saca el egreso de la caja elegida (categoría y referencia de multa) y la deja paga con comprobante', async () => {
      await service.pagar('m1', dto, 'd1', 'u1');

      expect(pagos.cajaDelPago).toHaveBeenCalledWith(manager, 'd1', 'caja1', [
        CashBoxKind.CASH,
        CashBoxKind.BANK,
        CashBoxKind.WALLET,
      ]);
      expect(pagos.egresar).toHaveBeenCalledWith(manager, {
        distributorId: 'd1',
        cashBoxId: 'caja1',
        amount: 59500,
        systemCode: CashSystemCode.TRAFFIC_FINE,
        referenceType: CashReferenceType.TRAFFIC_FINE,
        referenceId: 'm1',
        description: 'Multa A-0012345 — Municipalidad de Posadas (AB123CD)',
        userId: 'u1',
        method: CashMethod.TRANSFER,
      });
      expect(multa).toMatchObject({
        status: TrafficFineStatus.PAID,
        paidAt: new Date('2026-10-20T17:30:00.000Z'),
        paidAmount: 59500,
        operationNumber: '88123456',
        cashMovementId: 'mov1',
        receiptAttachmentId: 'a1',
      });
      expect(manager.save).toHaveBeenCalledWith(multa);
    });

    it.each([
      [CashBoxKind.CASH, CashMethod.CASH],
      [CashBoxKind.BANK, CashMethod.TRANSFER],
      [CashBoxKind.WALLET, CashMethod.MERCADOPAGO],
    ])('el medio del egreso sigue a la caja (%s)', async (_clase, medio) => {
      pagos.medioDeLaCaja.mockResolvedValue(medio);
      await service.pagar('m1', dto, 'd1', 'u1');
      expect(pagos.egresar).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ method: medio }),
      );
    });

    it('bloquea la multa de la distribuidora y valida que el comprobante sea de esa multa', async () => {
      await service.pagar('m1', dto, 'd1', 'u1');
      expect(manager.findOne).toHaveBeenCalledWith(
        TrafficFine,
        expect.objectContaining({
          where: { fineId: 'm1', distributorId: 'd1' },
          lock: expect.objectContaining({
            mode: 'pessimistic_write',
          }) as unknown,
        }),
      );
      expect(attachments.findDelDueno).toHaveBeenCalledWith(
        manager,
        'a1',
        AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
        'm1',
        'd1',
      );
    });

    it('una apelada también se paga', async () => {
      multa.status = TrafficFineStatus.APPEALED;
      await service.pagar('m1', dto, 'd1', 'u1');
      expect(multa.status).toBe(TrafficFineStatus.PAID);
    });

    it('sin operationNumber queda null', async () => {
      await service.pagar(
        'm1',
        { ...dto, operationNumber: undefined },
        'd1',
        'u1',
      );
      expect(multa.operationNumber).toBeNull();
    });

    it('una fecha sin hora es ese día en hora argentina', async () => {
      await service.pagar('m1', { ...dto, paidAt: '2026-10-20' }, 'd1', 'u1');
      expect(multa.paidAt).toEqual(new Date('2026-10-20T03:00:00.000Z'));
    });

    it('una fecha futura es 400 y no toca nada', async () => {
      const manana = new Date(Date.now() + 86_400_000).toISOString();
      await expect(
        service.pagar('m1', { ...dto, paidAt: manana }, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('una fecha anterior a la infracción es 400', async () => {
      await expect(
        service.pagar('m1', { ...dto, paidAt: '2026-08-01' }, 'd1', 'u1'),
      ).rejects.toThrow('anterior a la fecha de la infracción');
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('un importe mayor al de la multa es 400', async () => {
      await expect(
        service.pagar('m1', { ...dto, amount: 85000.01 }, 'd1', 'u1'),
      ).rejects.toThrow('no puede superar');
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('una multa ya paga es 409 y el asiento no se repite', async () => {
      multa.status = TrafficFineStatus.PAID;
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toThrow(
        'La multa ya está paga',
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('una multa anulada es 409', async () => {
      multa.status = TrafficFineStatus.VOIDED;
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('una multa de otra distribuidora es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.pagar('m1', dto, 'd2', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('un comprobante ajeno (de otra multa) es 400 y no se paga', async () => {
      attachments.findDelDueno.mockResolvedValue(null);
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toThrow(
        'no es de esta multa',
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('la copia del acta (dueño traffic_fine) no sirve de comprobante: sólo se busca el dueño del pago', async () => {
      attachments.findDelDueno.mockImplementation(
        (_m: unknown, _id: string, tipo: AttachmentOwnerType) =>
          Promise.resolve(
            tipo === AttachmentOwnerType.TRAFFIC_FINE
              ? { attachmentId: 'a1', mimeType: 'image/png' }
              : null,
          ),
      );
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toThrow(
        'no es de esta multa',
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('un comprobante que no es PDF ni imagen es 400', async () => {
      attachments.findDelDueno.mockResolvedValue({
        attachmentId: 'a1',
        mimeType: 'text/csv',
      });
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('sin caja (con cajas de efectivo activas el servicio de caja ya la exige) es 400', async () => {
      pagos.cajaDelPago.mockResolvedValue(null);
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toThrow(
        'indicá la caja',
      );
      expect(pagos.egresar).not.toHaveBeenCalled();
    });

    it('si la caja rechaza el egreso la multa no queda paga', async () => {
      pagos.egresar.mockRejectedValue(new ConflictException('sin saldo'));
      await expect(service.pagar('m1', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });
  });
});
