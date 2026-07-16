// src/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentGatewayPort } from './domain/ports/payment-gateway.port';
import { MercadoPagoAdapter } from './infrastructure/mercadopago.adapter';
import { PaymentsService } from './application/payments.service';

/**
 * Módulo de pagos, independiente de `order`: expone `PaymentsService`
 * (gateway-agnóstico) para que cualquier módulo que necesite cobrar (hoy solo
 * `order`) lo consuma sin conocer MercadoPago ni el SDK concreto. `payments`
 * NO importa `order` — la dependencia va en un solo sentido (order → payments)
 * para evitar un ciclo de módulos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Payment])],
  providers: [
    PaymentsService,
    // Puerto de pasarela de pago → adapter MercadoPago (Checkout Pro). Sumar
    // un gateway nuevo = agregar un adapter + resolverlo acá (o por config).
    { provide: PaymentGatewayPort, useClass: MercadoPagoAdapter },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
