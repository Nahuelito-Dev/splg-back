import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AttachmentMapper } from '../../attachment/attachment.mapper';
import { AttachmentService } from '../../attachment/attachment.service';
import type { AttachmentActor } from '../../attachment/attachment.service';
import { AttachmentResponseDto } from '../../attachment/dto/attachment-response.dto';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';
import { esMimeTypePermitido } from '../../common/utils/attachment-rules';
import { BankDetailsResponseDto } from '../../distributor/dto/bank-details.dto';
import { DistributorBankService } from '../../distributor/distributor-bank.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderReceiptFileDto } from '../dto/transfer-receipt.dto';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

/** Evento que recibe el panel cuando el cliente sube su comprobante. */
export const EVENTO_COMPROBANTE_SUBIDO = 'order:transfer-receipt-uploaded';

/** Cuántos comprobantes puede subir el cliente por pedido (cuida el bucket). */
export const MAX_COMPROBANTES_POR_PEDIDO = 5;

export const ETIQUETA_COMPROBANTE = 'Comprobante de transferencia';

/**
 * Comprobante de una transferencia (API v2): el cliente sube el de SU pedido
 * mientras el pago está pendiente, el admin lo ve y el panel se entera en vivo.
 * El archivo es un adjunto del dueño `order`; acá van las reglas del pedido.
 */
@Injectable()
export class OrderTransferReceiptService {
  private readonly logger = new Logger(OrderTransferReceiptService.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly attachments: AttachmentService,
    private readonly bank: DistributorBankService,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * El cliente sube el comprobante de su pedido. El archivo, la nota del
   * historial y el cupo se resuelven en una sola transacción con el pedido
   * bloqueado: si el pago se confirma o el pedido se cancela en el medio, no
   * queda nada.
   */
  async subir(
    orderId: string,
    customerUserId: string,
    file: Express.Multer.File | undefined,
  ): Promise<AttachmentResponseDto> {
    const order = await this.pedidoDelCliente(orderId, customerUserId);
    this.exigirSubible(order);
    if (file && !esMimeTypePermitido(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `El comprobante tiene que ser una imagen (JPG, PNG, WEBP) o un PDF (${file.mimetype})`,
      );
    }
    const actor: AttachmentActor = {
      userId: customerUserId,
      role: RoleType.CUSTOMER,
    };

    const attachment = await this.attachments.upload(
      AttachmentOwnerType.ORDER,
      orderId,
      order.distributorId,
      file,
      ETIQUETA_COMPROBANTE,
      actor,
      {
        dentro: async (manager) => {
          const bloqueado = await this.bloquear(manager, orderId);
          this.exigirSubible(bloqueado);
          // El recién guardado ya cuenta.
          const subidos = await manager.count(Attachment, {
            where: {
              distributorId: order.distributorId,
              ownerType: AttachmentOwnerType.ORDER,
              ownerId: orderId,
              label: ETIQUETA_COMPROBANTE,
            },
          });
          if (subidos > MAX_COMPROBANTES_POR_PEDIDO) {
            throw new ConflictException(
              `El pedido ya tiene ${MAX_COMPROBANTES_POR_PEDIDO} comprobantes: no se pueden subir más`,
            );
          }
          await manager.insert(OrderStatusHistory, {
            orderId,
            fromStatus: bloqueado.status,
            toStatus: bloqueado.status,
            changedByUserId: customerUserId,
            reason: 'El cliente subió el comprobante de la transferencia',
          });
        },
      },
    );

    this.avisarAlPanel(order, attachment.attachmentId);
    return AttachmentMapper.toDto(attachment);
  }

  /**
   * Los adjuntos del pedido con su enlace firmado. Lo ve el cliente dueño y el
   * admin de la distribuidora del pedido (para el super admin, la del
   * `X-Distributor`); lo ajeno es 404.
   */
  async listar(
    orderId: string,
    actor: AttachmentActor,
    distributorId: string | null,
  ): Promise<OrderReceiptFileDto[]> {
    const order =
      actor.role === RoleType.CUSTOMER
        ? await this.pedidoDelCliente(orderId, actor.userId)
        : await this.pedidoDeLaDistribuidora(orderId, distributorId);
    const esCliente = actor.role === RoleType.CUSTOMER;
    const adjuntos = (
      await this.attachments.list(
        AttachmentOwnerType.ORDER,
        orderId,
        order.distributorId,
        actor,
      )
    ).filter(
      // El cliente ve sólo los comprobantes de transferencia (los que subió él
      // o los que el admin rotuló así a propósito), nunca otros adjuntos
      // internos del pedido.
      (adjunto) => !esCliente || adjunto.label === ETIQUETA_COMPROBANTE,
    );
    return Promise.all(
      adjuntos.map(async (adjunto) => {
        const firmado = await this.attachments.getSignedDownload(
          adjunto.attachmentId,
          order.distributorId,
          actor,
          'inline',
        );
        const dto = new OrderReceiptFileDto();
        dto.attachmentId = adjunto.attachmentId;
        dto.ownerType = adjunto.ownerType;
        dto.ownerId = adjunto.ownerId;
        dto.label = adjunto.label;
        dto.originalName = adjunto.originalName;
        dto.mimeType = adjunto.mimeType;
        dto.sizeBytes = adjunto.sizeBytes;
        dto.uploadedAt = adjunto.uploadedAt;
        if (!esCliente) dto.uploadedByUserId = adjunto.uploadedByUserId;
        dto.url = firmado.url;
        dto.expiresAt = firmado.expiresAt;
        return dto;
      }),
    );
  }

  /** CBU, alias y titular de la distribuidora de un pedido que se paga por transferencia. */
  async datosBancarios(
    orderId: string,
    customerUserId: string,
  ): Promise<BankDetailsResponseDto> {
    const order = await this.pedidoDelCliente(orderId, customerUserId);
    if (order.paymentMethod !== PaymentMethod.TRANSFER) {
      throw new BadRequestException(
        'El pedido no se paga por transferencia: no hay datos bancarios para mostrar',
      );
    }
    return this.bank.obtener(order.distributorId);
  }

  private async pedidoDelCliente(
    orderId: string,
    customerUserId: string,
  ): Promise<Order> {
    const order = await this.orders.findOne({ where: { orderId } });
    if (!order || order.customerId !== customerUserId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    return order;
  }

  private async pedidoDeLaDistribuidora(
    orderId: string,
    distributorId: string | null,
  ): Promise<Order> {
    const order = await this.orders.findOne({ where: { orderId } });
    if (!order || (distributorId && order.distributorId !== distributorId)) {
      throw new NotFoundException('Pedido no encontrado');
    }
    return order;
  }

  private async bloquear(
    manager: EntityManager,
    orderId: string,
  ): Promise<Order> {
    const order = await manager
      .createQueryBuilder(Order, 'order')
      .setLock('pessimistic_write')
      .where('order.orderId = :orderId', { orderId })
      .getOne();
    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }
    return order;
  }

  /** Transferencia, no cancelada y con el pago pendiente o marcado como no recibido. */
  private exigirSubible(order: Order): void {
    if (order.paymentMethod !== PaymentMethod.TRANSFER) {
      throw new BadRequestException(
        'Sólo se sube comprobante en los pedidos que se pagan por transferencia',
      );
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new ConflictException(
        'El pedido está cancelado: no se sube comprobante',
      );
    }
    // `failed` (el admin la marcó "no recibida") se puede corregir con el
    // comprobante: ahí es cuando más hace falta.
    if (
      order.paymentStatus !== PaymentStatus.PENDING &&
      order.paymentStatus !== PaymentStatus.FAILED
    ) {
      throw new ConflictException(
        'El pago de este pedido ya se resolvió: no se sube comprobante',
      );
    }
  }

  /** Aviso en vivo al panel; el comprobante ya está guardado, así que nunca lanza. */
  private avisarAlPanel(order: Order, attachmentId: string): void {
    try {
      this.dispatch.notifyAdmins(
        EVENTO_COMPROBANTE_SUBIDO,
        {
          orderId: order.orderId,
          // El superadmin recibe los avisos de todas las empresas y filtra por la que está mirando.
          distributorId: order.distributorId,
          customerId: order.customerId,
          attachmentId,
          uploadedAt: new Date(),
        },
        order.distributorId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir ${EVENTO_COMPROBANTE_SUBIDO} del pedido ${order.orderId}: ${errorMessage(error)}`,
      );
    }
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: order.distributorId,
      kind: 'transfer_receipt_uploaded',
      title: 'Comprobante de transferencia',
      body: `Pedido #${idCortoDePedido(order.orderId)}: el cliente subió un comprobante de pago.`,
      link: { entity: 'order', id: order.orderId },
      dedupeKey: `transfer-receipt:${attachmentId}`,
    });
  }
}
