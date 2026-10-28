import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { AttachmentService } from '../../attachment/attachment.service';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { DistributorBankService } from '../../distributor/distributor-bank.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import {
  EVENTO_COMPROBANTE_SUBIDO,
  ETIQUETA_COMPROBANTE,
  MAX_COMPROBANTES_POR_PEDIDO,
  OrderTransferReceiptService,
} from './order-transfer-receipt.service';

function pedido(over: Partial<Order> = {}): Order {
  return {
    orderId: 'o1',
    distributorId: 'd1',
    customerId: 'cli1',
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.TRANSFER,
    paymentStatus: PaymentStatus.PENDING,
    ...over,
  } as Order;
}

function archivo(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'comprobante.pdf',
    mimetype: 'application/pdf',
    size: 100,
    buffer: Buffer.from('%PDF-1.4'),
    ...over,
  } as Express.Multer.File;
}

describe('OrderTransferReceiptService', () => {
  let service: OrderTransferReceiptService;
  let orders: { findOne: jest.Mock };
  let attachments: {
    upload: jest.Mock;
    list: jest.Mock;
    getSignedDownload: jest.Mock;
  };
  let bank: { obtener: jest.Mock };
  let dispatch: { notifyAdmins: jest.Mock };
  let manager: {
    createQueryBuilder: jest.Mock;
    count: jest.Mock;
    insert: jest.Mock;
  };
  let bloqueado: Order;

  /** Corre el trabajo extra que el servicio le pasa al guardado del adjunto. */
  async function conLaTransaccion(
    ...args: unknown[]
  ): Promise<Partial<Attachment>> {
    const hooks = args[6] as {
      dentro: (m: EntityManager, a: Attachment) => Promise<void>;
    };
    const guardado = { attachmentId: 'a1' } as Attachment;
    await hooks.dentro(manager as unknown as EntityManager, guardado);
    return {
      attachmentId: 'a1',
      ownerType: AttachmentOwnerType.ORDER,
      ownerId: 'o1',
    };
  }

  beforeEach(() => {
    bloqueado = pedido();
    orders = { findOne: jest.fn().mockResolvedValue(pedido()) };
    attachments = {
      upload: jest.fn(conLaTransaccion),
      list: jest.fn(),
      getSignedDownload: jest.fn(),
    };
    bank = { obtener: jest.fn() };
    dispatch = { notifyAdmins: jest.fn() };
    manager = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(() => Promise.resolve(bloqueado)),
      })),
      count: jest.fn().mockResolvedValue(1),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    service = new OrderTransferReceiptService(
      orders as unknown as Repository<Order>,
      attachments as unknown as AttachmentService,
      bank as unknown as DistributorBankService,
      dispatch as unknown as RealtimeDispatchPort,
    );
  });

  describe('subir', () => {
    it('sube el comprobante a nombre del cliente, deja una nota en el historial y avisa al panel de ESA distribuidora', async () => {
      const file = archivo();
      const res = await service.subir('o1', 'cli1', file);

      expect(attachments.upload).toHaveBeenCalledWith(
        AttachmentOwnerType.ORDER,
        'o1',
        'd1',
        file,
        ETIQUETA_COMPROBANTE,
        { userId: 'cli1', role: RoleType.CUSTOMER },
        expect.objectContaining({ dentro: expect.any(Function) as unknown }),
      );
      expect(manager.insert).toHaveBeenCalledWith(OrderStatusHistory, {
        orderId: 'o1',
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.PENDING,
        changedByUserId: 'cli1',
        reason: 'El cliente subió el comprobante de la transferencia',
      });
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        EVENTO_COMPROBANTE_SUBIDO,
        expect.objectContaining({
          orderId: 'o1',
          distributorId: 'd1',
          customerId: 'cli1',
          attachmentId: 'a1',
        }),
        'd1',
      );
      expect(res.attachmentId).toBe('a1');
    });

    it('el evento tiene el nombre que escucha el panel', () => {
      expect(EVENTO_COMPROBANTE_SUBIDO).toBe('order:transfer-receipt-uploaded');
    });

    it('un pedido de otro cliente es 404 y no sube nada', async () => {
      await expect(
        service.subir('o1', 'otro-cliente', archivo()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attachments.upload).not.toHaveBeenCalled();
    });

    it('un pedido inexistente es 404', async () => {
      orders.findOne.mockResolvedValue(null);
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un pedido que no es por transferencia es 400', async () => {
      orders.findOne.mockResolvedValue(
        pedido({ paymentMethod: PaymentMethod.MERCADOPAGO }),
      );
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(attachments.upload).not.toHaveBeenCalled();
    });

    it('con el pago marcado como no recibido (failed) se acepta: es cuando más hace falta', async () => {
      orders.findOne.mockResolvedValue(
        pedido({ paymentStatus: PaymentStatus.FAILED }),
      );
      bloqueado = pedido({ paymentStatus: PaymentStatus.FAILED });
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).resolves.toMatchObject({ attachmentId: 'a1' });
    });

    it.each([
      [PaymentStatus.PAID],
      [PaymentStatus.UNPAID],
      [PaymentStatus.WRITTEN_OFF],
    ])('con el pago en %s es 409', async (paymentStatus) => {
      orders.findOne.mockResolvedValue(pedido({ paymentStatus }));
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(attachments.upload).not.toHaveBeenCalled();
    });

    it('un pedido cancelado es 409', async () => {
      orders.findOne.mockResolvedValue(
        pedido({ status: OrderStatus.CANCELLED }),
      );
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sólo imagen o PDF: un Word es 415 y no se sube', async () => {
      await expect(
        service.subir(
          'o1',
          'cli1',
          archivo({
            mimetype:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(attachments.upload).not.toHaveBeenCalled();
    });

    it('sin archivo deja que el servicio de adjuntos conteste el 400', async () => {
      attachments.upload.mockRejectedValue(new BadRequestException('Falta'));
      await expect(
        service.subir('o1', 'cli1', undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    });

    it('si el pago se confirmó mientras subía, la transacción lo frena (409) y no avisa', async () => {
      bloqueado = pedido({ paymentStatus: PaymentStatus.PAID });
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.insert).not.toHaveBeenCalled();
      expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    });

    it('con el tope de comprobantes ya alcanzado, el siguiente es 409', async () => {
      manager.count.mockResolvedValue(MAX_COMPROBANTES_POR_PEDIDO + 1);
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('el último comprobante que entra en el tope se acepta', async () => {
      manager.count.mockResolvedValue(MAX_COMPROBANTES_POR_PEDIDO);
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).resolves.toBeDefined();
    });

    it('si el aviso al panel falla, el comprobante igual queda subido', async () => {
      dispatch.notifyAdmins.mockImplementation(() => {
        throw new Error('socket caído');
      });
      await expect(
        service.subir('o1', 'cli1', archivo()),
      ).resolves.toMatchObject({ attachmentId: 'a1' });
    });
  });

  describe('listar', () => {
    const adjunto = {
      attachmentId: 'a1',
      ownerType: AttachmentOwnerType.ORDER,
      ownerId: 'o1',
      label: ETIQUETA_COMPROBANTE,
      originalName: 'c.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      uploadedByUserId: 'cli1',
      uploadedAt: new Date('2026-10-27T10:00:00Z'),
    } as Attachment;
    const vence = new Date('2026-10-27T10:05:00Z');

    beforeEach(() => {
      attachments.list.mockResolvedValue([adjunto]);
      attachments.getSignedDownload.mockResolvedValue({
        url: 'https://s3/firmada',
        expiresAt: vence,
      });
    });

    it('el admin ve los adjuntos del pedido de su distribuidora con la URL firmada inline', async () => {
      const res = await service.listar(
        'o1',
        { userId: 'adm1', role: RoleType.ADMIN },
        'd1',
      );
      expect(attachments.list).toHaveBeenCalledWith(
        AttachmentOwnerType.ORDER,
        'o1',
        'd1',
        { userId: 'adm1', role: RoleType.ADMIN },
      );
      expect(attachments.getSignedDownload).toHaveBeenCalledWith(
        'a1',
        'd1',
        { userId: 'adm1', role: RoleType.ADMIN },
        'inline',
      );
      expect(res).toEqual([
        expect.objectContaining({
          attachmentId: 'a1',
          url: 'https://s3/firmada',
          expiresAt: vence,
        }),
      ]);
    });

    it('el admin de otra distribuidora recibe 404', async () => {
      await expect(
        service.listar('o1', { userId: 'adm2', role: RoleType.ADMIN }, 'd2'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attachments.list).not.toHaveBeenCalled();
    });

    it('el cliente ve sólo los comprobantes de transferencia, sin quién los subió; el admin ve todo', async () => {
      const interno = {
        ...adjunto,
        attachmentId: 'a2',
        label: 'Remito interno',
        uploadedByUserId: 'adm1',
      } as Attachment;
      attachments.list.mockResolvedValue([adjunto, interno]);

      const delCliente = await service.listar(
        'o1',
        { userId: 'cli1', role: RoleType.CUSTOMER },
        null,
      );
      expect(delCliente.map((r) => r.attachmentId)).toEqual(['a1']);
      expect(delCliente[0].uploadedByUserId).toBeUndefined();

      const delAdmin = await service.listar(
        'o1',
        { userId: 'adm1', role: RoleType.ADMIN },
        'd1',
      );
      expect(delAdmin.map((r) => r.attachmentId)).toEqual(['a1', 'a2']);
      expect(delAdmin[1].uploadedByUserId).toBe('adm1');
    });

    it('el cliente ve los de su pedido; el de otro cliente recibe 404', async () => {
      await expect(
        service.listar('o1', { userId: 'cli1', role: RoleType.CUSTOMER }, null),
      ).resolves.toHaveLength(1);
      await expect(
        service.listar('o1', { userId: 'cli2', role: RoleType.CUSTOMER }, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un pedido inexistente es 404', async () => {
      orders.findOne.mockResolvedValue(null);
      await expect(
        service.listar('o1', { userId: 'adm1', role: RoleType.ADMIN }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('datosBancarios', () => {
    it('devuelve los de la distribuidora DEL PEDIDO, no los de otra', async () => {
      bank.obtener.mockResolvedValue({ cbu: 'x', alias: 'y', holder: 'z' });
      await expect(service.datosBancarios('o1', 'cli1')).resolves.toEqual({
        cbu: 'x',
        alias: 'y',
        holder: 'z',
      });
      expect(bank.obtener).toHaveBeenCalledWith('d1');
    });

    it('un pedido ajeno es 404', async () => {
      await expect(service.datosBancarios('o1', 'cli2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(bank.obtener).not.toHaveBeenCalled();
    });

    it('un pedido que no es por transferencia es 400', async () => {
      orders.findOne.mockResolvedValue(
        pedido({ paymentMethod: PaymentMethod.CASH }),
      );
      await expect(service.datosBancarios('o1', 'cli1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
