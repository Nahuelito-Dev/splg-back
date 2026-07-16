// src/order/order.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { DispatchOffer } from './entities/dispatch-offer.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { User } from '../users/entities/user.entity';
import { Delivery } from '../delivery/entities/delivery.entity';
import { UserAddress } from '../user-addres/entities/user-addres.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Customer } from '../customer/entities/customer.entity';

import { GatewaysModule } from '../gateways/gateways.module';
import { RedisModule } from '../redis/redis.module'; // 👈 Importar
import { TimeSlotModule } from '../time-slot/time-slot.module';
import { DispatchService } from './dispatch.service';
import { OrderPricingService } from './domain/order-pricing.service';
import { StockReservationService } from './domain/stock-reservation.service';
import { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import { RealtimeDispatchAdapter } from './infrastructure/realtime-dispatch.adapter';
import { OrderRepositoryPort } from './domain/ports/order.repository.port';
import { OrderTypeormRepository } from './infrastructure/order.typeorm.repository';
import { CreateOrderUseCase } from './application/create-order.use-case';
import { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import { CancelOrderUseCase } from './application/cancel-order.use-case';
import { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import { DispatchOfferRepositoryPort } from './domain/ports/dispatch-offer.repository.port';
import { DispatchOfferTypeormRepository } from './infrastructure/dispatch-offer.typeorm.repository';
import { ConfirmPaymentUseCase } from './application/confirm-payment.use-case';
import { ReservationService } from './application/reservation.service';
import { MercadoPagoWebhookController } from './mercadopago-webhook.controller';
import { CylinderModule } from '../cylinder/cylinder.module';
import { CoverageZoneModule } from '../coverage-zone/coverage-zone.module';
import { CylinderLifecyclePort } from './domain/ports/cylinder-lifecycle.port';
import { CylinderLifecycleAdapter } from './infrastructure/cylinder-lifecycle.adapter';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationPort } from './domain/ports/notification.port';
import { NotificationAdapter } from './infrastructure/notification.adapter';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      DispatchOffer,
      GasCylinder,
      User,
      Delivery,
      UserAddress,
      Customer,
    ]),
    NotificationsModule,
    GatewaysModule,
    RedisModule, // 👈 AGREGAR ESTO AQUÍ
    TimeSlotModule, // agendamiento: valida cupo de franja al crear pedido
    CylinderModule, // ciclo del envase físico: al entregar, avanza los envases
    CoverageZoneModule, // valida cobertura de la dirección + recargo por zona
    PaymentsModule, // pasarela de pago (MercadoPago) + ledger, módulo propio
  ],
  controllers: [OrderController, MercadoPagoWebhookController],
  providers: [
    OrderService,
    DispatchService,
    OrderPricingService,
    StockReservationService,
    CreateOrderUseCase,
    UpdateOrderStatusUseCase,
    CancelOrderUseCase,
    ConfirmDeliveryUseCase,
    DispatchOrchestratorService,
    ConfirmPaymentUseCase,
    ReservationService,
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
    // Puerto de notificación al cliente → adapter que delega en NotificationsService.
    { provide: NotificationPort, useClass: NotificationAdapter },
  ],
  exports: [OrderService],
})
export class OrderModule {}
