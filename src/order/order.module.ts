import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExpressOrderController } from './express-order.controller';
import { OrderController } from './order.controller';
import { CustomerPurchaseStatsController } from './customer-purchase-stats.controller';
import { CustomerPurchaseStatsService } from './application/customer-purchase-stats.service';
import { OrderService } from './order.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { DispatchOffer } from './entities/dispatch-offer.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CustomersModule } from '../customer/customer.module';
import { UserAddressModule } from '../user-address/user-address.module';

import { GatewaysModule } from '../gateways/gateways.module';
import { RedisModule } from '../redis/redis.module';
import { TimeSlotModule } from '../time-slot/time-slot.module';
import { DispatchService } from './dispatch.service';
import { OrderPricingService } from './domain/order-pricing.service';
import { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import { RealtimeDispatchAdapter } from './infrastructure/realtime-dispatch.adapter';
import { OrderRepositoryPort } from './domain/ports/order.repository.port';
import { OrderTypeormRepository } from './infrastructure/order.typeorm.repository';
import { CreateOrderUseCase } from './application/create-order.use-case';
import { QuoteOrderUseCase } from './application/quote-order.use-case';
import { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import { OrderDriverPhotoService } from './application/order-driver-photo.service';
import { UpdateOrderUseCase } from './application/update-order.use-case';
import { ChangeOrderAddressUseCase } from './application/change-order-address.use-case';
import { SetOrderReceiverUseCase } from './application/set-order-receiver.use-case';
import { ReceiverRetentionCron } from './application/receiver-retention.cron';
import { CancelOrderUseCase } from './application/cancel-order.use-case';
import { ReleaseOrderUseCase } from './application/release-order.use-case';
import { CashCollectionUseCase } from './application/cash-collection.use-case';
import { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import { ExpressAvailabilityService } from './application/express-availability.service';
import { ExpressDegradeService } from './application/express-degrade.service';
import { DeliveryOptionsUseCase } from './application/delivery-options.use-case';
import { ExpressPurchaseUseCase } from './application/express-purchase.use-case';
import { ReintegroListener } from './application/reintegro.listener';
import { DispatchOfferRepositoryPort } from './domain/ports/dispatch-offer.repository.port';
import { DispatchOfferTypeormRepository } from './infrastructure/dispatch-offer.typeorm.repository';
import { ConfirmPaymentUseCase } from './application/confirm-payment.use-case';
import { OrderFraudHoldService } from './application/order-fraud-hold.service';
import { OrderPaymentV2Controller } from './order-payment-v2.controller';
import { DeliveryCodeV2Controller } from './delivery-code-v2.controller';
import { ReservationV2Controller } from './reservation-v2.controller';
import { ConciliacionMercadoPagoService } from './application/conciliacion-mercadopago.service';
import { ReservationService } from './application/reservation.service';
import { PagoNotificadoListener } from './application/pago-notificado.listener';
import { AttachmentModule } from '../attachment/attachment.module';
import { OrderAttachmentOwnerResolver } from './application/order-attachment-owner.resolver';
import { OrderTransferReceiptService } from './application/order-transfer-receipt.service';
import { OrderTransferReceiptController } from './order-transfer-receipt.controller';
import { CashModule } from '../cash/cash.module';
import { CylinderModule } from '../cylinder/cylinder.module';
import { CoverageZoneModule } from '../coverage-zone/coverage-zone.module';
import { CylinderLifecyclePort } from './domain/ports/cylinder-lifecycle.port';
import { CylinderLifecycleAdapter } from './infrastructure/cylinder-lifecycle.adapter';
import { OrderLookupModule } from './lookup/order-lookup.module';
import { PaymentsModule } from '../payments/payments.module';
import { CustomerAccountModule } from '../customer-account/customer-account.module';
import { CustomerAccountPort } from './domain/ports/customer-account.port';
import { CustomerAccountAdapter } from './infrastructure/customer-account.adapter';
import { FleetModule } from '../fleet/fleet.module';
import { StockModule } from '../stock/stock.module';
import { TruckLoadModule } from '../truck-load/truck-load.module';
import { CartModule } from '../cart/cart.module';
import { S3Module } from '../s3/s3.module';
import { NotificationPort } from './domain/ports/notification.port';
import { OrderStatusHistorySubscriber } from './infrastructure/order-status-history.subscriber';
import { DriverRatingPort } from './domain/ports/driver-rating.port';
import { DriverRatingTypeormAdapter } from './infrastructure/driver-rating.typeorm.adapter';
import { NotificationAdapter } from './infrastructure/notification.adapter';
import { OrderStatusHistory } from './entities/order-status-history.entity';
import { OrderAddressChange } from './entities/order-address-change.entity';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      DispatchOffer,
      OrderStatusHistory,
      OrderAddressChange,
    ]),
    CartModule, // checkout del carrito: ítems y vaciado en la transacción del pedido (CU-126)
    S3Module, // foto firmada del chofer en el tracking
    GasCylinderModule, // catálogo: reserva y devolución de stock
    DeliveryModule, // choferes: pertenencia, asignación y disponibles
    CustomersModule, // el cliente del pedido tiene que existir
    UserAddressModule, // la dirección tiene que ser del cliente
    NotificationsModule,
    GatewaysModule,
    RedisModule,
    TimeSlotModule, // agendamiento: valida cupo de franja al crear pedido
    CylinderModule, // ciclo del envase físico: al entregar, avanza los envases
    CoverageZoneModule, // valida cobertura de la dirección + recargo por zona
    OrderLookupModule, // lecturas del pedido (ReintegroListener)
    PaymentsModule, // pasarela de pago (MercadoPago) + ledger, módulo propio
    CustomerAccountModule, // venta a cuenta corriente: control de crédito (CustomerAccountPort)
    FleetModule, // bloqueo de flota (CU-136 a CU-138): el despacho no ofrece ni asigna a un chofer inhabilitado
    StockModule, // al entregar, descuenta el físico del camión o del depósito (StockDeliveryPort)
    CashModule, // el cobro del admin entra a una caja por el libro (CashLedgerService)
    AttachmentModule, // dueño `order` de los adjuntos: comprobante de la transferencia
    TruckLoadModule, // D5: con control de carga activo, el despacho exige carga abierta (TruckLoadGatePort)
  ],
  // ExpressOrderController va primero: `GET /orders/delivery-options` no puede caer en `GET /orders/:id`.
  controllers: [
    ExpressOrderController,
    OrderController,
    OrderTransferReceiptController,
    ReservationV2Controller,
    DeliveryCodeV2Controller,
    OrderPaymentV2Controller,
    CustomerPurchaseStatsController,
  ],
  providers: [
    // Confirma el pedido cuando payments publica un pago notificado.
    PagoNotificadoListener,
    OrderService,
    OrderFraudHoldService,
    OrderAttachmentOwnerResolver,
    OrderTransferReceiptService,
    DispatchService,
    OrderPricingService,
    CreateOrderUseCase,
    QuoteOrderUseCase,
    UpdateOrderUseCase,
    ChangeOrderAddressUseCase,
    SetOrderReceiverUseCase,
    ReceiverRetentionCron,
    UpdateOrderStatusUseCase,
    OrderDriverPhotoService,
    CancelOrderUseCase,
    ReleaseOrderUseCase,
    ConfirmDeliveryUseCase,
    CashCollectionUseCase,
    // Historial de estados: una fila por transición, en la misma transacción.
    OrderStatusHistorySubscriber,
    DispatchOrchestratorService,
    ExpressAvailabilityService,
    ExpressDegradeService,
    DeliveryOptionsUseCase,
    ExpressPurchaseUseCase,
    // Avisa al cliente y al panel cuando `payments` resuelve una devolución (CU-168).
    ReintegroListener,
    ConfirmPaymentUseCase,
    ReservationService,
    ConciliacionMercadoPagoService,
    CustomerPurchaseStatsService,
    // Puerto de tiempo real → adapter concreto (Redis GEO + Socket.io gateways).
    // Cambiar el transporte = cambiar solo esta línea.
    { provide: RealtimeDispatchPort, useClass: RealtimeDispatchAdapter },
    // Puerto de persistencia → adapter TypeORM.
    { provide: OrderRepositoryPort, useClass: OrderTypeormRepository },
    // Puerto de ofertas de despacho → adapter TypeORM.
    {
      provide: DispatchOfferRepositoryPort,
      useClass: DispatchOfferTypeormRepository,
    },
    // Puerto del ciclo del envase → adapter que delega en CylinderService.
    { provide: CylinderLifecyclePort, useClass: CylinderLifecycleAdapter },
    { provide: CustomerAccountPort, useClass: CustomerAccountAdapter },
    // Puerto de la calificación del chofer → lectura directa de `rating`.
    { provide: DriverRatingPort, useClass: DriverRatingTypeormAdapter },
    // Puerto de notificación al cliente → adapter que delega en NotificationsService.
    { provide: NotificationPort, useClass: NotificationAdapter },
  ],
  exports: [
    OrderService,
    QuoteOrderUseCase,
    CashCollectionUseCase,
    DispatchOrchestratorService,
  ],
})
export class OrderModule {}
