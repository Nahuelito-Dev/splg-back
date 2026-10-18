import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { Payment } from './entities/payment.entity';
import { PaymentRefund } from './entities/payment-refund.entity';
import { PaymentGatewayPort } from './domain/ports/payment-gateway.port';
import { MercadoPagoAdapter } from './infrastructure/mercadopago.adapter';
import { PaymentsService } from './application/payments.service';
import { RefundsService } from './application/refunds.service';
import { RefundsController } from './presentation/refunds.controller';
import { MercadoPagoWebhookController } from './presentation/mercadopago-webhook.controller';

/**
 * Módulo de pagos, independiente de `order`: expone `PaymentsService`
 * (gateway-agnóstico) para que cualquier módulo que necesite cobrar (hoy solo
 * `order`) lo consuma sin conocer MercadoPago ni el SDK concreto. `payments`
 * NO importa `order` — la dependencia va en un solo sentido (order → payments)
 * para evitar un ciclo de módulos.
 */
@Module({
  // `OrderLookupModule` no depende de nadie: sólo lee el estado del pedido.
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentRefund]),
    OrderLookupModule,
  ],
  // El webhook valida la firma y publica PagoNotificadoEvent; order lo escucha.
  controllers: [MercadoPagoWebhookController, RefundsController],
  providers: [
    PaymentsService,
    RefundsService,
    // Puerto de pasarela de pago → adapter MercadoPago (Checkout Pro). Sumar
    // un gateway nuevo = agregar un adapter + resolverlo acá (o por config).
    { provide: PaymentGatewayPort, useClass: MercadoPagoAdapter },
  ],
  exports: [PaymentsService, RefundsService],
})
export class PaymentsModule {}
