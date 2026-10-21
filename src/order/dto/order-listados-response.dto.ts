import { ApiProperty } from '@nestjs/swagger';
import { OrderResponseDto } from './order-response.dto';
import { PaymentMethod } from '../entities/order.entity';

/** Listados paginados de pedidos (`GET /orders`, por cliente, por chofer, disponibles). */
export class PaginatedOrdersResponseDto {
  @ApiProperty({ type: OrderResponseDto, isArray: true })
  orders!: OrderResponseDto[];
  @ApiProperty({ example: 180 }) total!: number;
  @ApiProperty({ example: 10 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}

/** `GET /orders/available`: la lista del pool y si el chofer tiene que abrir su carga. */
export class AvailableOrdersResponseDto extends PaginatedOrdersResponseDto {
  @ApiProperty({
    example: false,
    description:
      'true si la distribuidora exige la carga del día abierta y el chofer no la tiene: `orders` viene vacío y la app avisa `message`',
  })
  openLoadRequired!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Abrí tu carga para recibir pedidos',
  })
  message!: string | null;
}

export class RenglonDeReservaDto {
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiProperty({ type: String, nullable: true, example: '10kg' })
  type!: string | null;
}

/** La franja horaria elegida para la entrega de una reserva. */
export class FranjaDeReservaDto {
  @ApiProperty({ example: 'Mañana' }) name!: string;
  @ApiProperty({ example: '08:00', description: 'HH:MM' }) startTime!: string;
  @ApiProperty({ example: '12:00', description: 'HH:MM' }) endTime!: string;
}

/** Una reserva pendiente de `GET /orders/reservations`. */
export class ReservaResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) customerPhone!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  scheduledDate!: string | null;
  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  paymentMethod!: PaymentMethod;
  @ApiProperty({ example: 22600 }) total!: number;
  @ApiProperty({ example: 5000 }) depositAmount!: number;
  @ApiProperty() depositPaid!: boolean;
  @ApiProperty({ example: 17600, description: 'Total menos la seña cobrada' })
  remainingBalance!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Enlace de pago de MercadoPago de la seña mientras esté pendiente; `null` si la seña es en efectivo o por transferencia, ya está paga o no se generó',
  })
  paymentUrl!: string | null;
  @ApiProperty({
    type: FranjaDeReservaDto,
    nullable: true,
    description:
      'Franja de entrega elegida; `null` si la reserva es sólo por día',
  })
  timeSlot!: FranjaDeReservaDto | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: RenglonDeReservaDto, isArray: true })
  items!: RenglonDeReservaDto[];
}

/** `POST /orders/:id/reject`: si había una oferta activa para ese chofer. */
export class RechazoDeOfertaResponseDto {
  @ApiProperty({
    description:
      'true: el rechazo se registró (con oferta real, se re-ofrece; con asignación manual, se avisa al panel). El pedido que no existe responde 404, no `false`.',
  })
  rejected!: boolean;
}

/** `GET /orders/:id/delivery-code`: el código que el chofer muestra como QR. */
export class CodigoDeEntregaResponseDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'E498F43C8A' })
  deliveryCode!: string | null;
}
