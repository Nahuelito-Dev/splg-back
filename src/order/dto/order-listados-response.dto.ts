import { ApiProperty } from '@nestjs/swagger';
import { OrderResponseDto } from './order-response.dto';

/** Listados paginados de pedidos (`GET /orders`, por cliente, por chofer, disponibles). */
export class PaginatedOrdersResponseDto {
  @ApiProperty({ type: OrderResponseDto, isArray: true })
  orders!: OrderResponseDto[];
  @ApiProperty({ example: 180 }) total!: number;
  @ApiProperty({ example: 10 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}

export class RenglonDeReservaDto {
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiProperty({ type: String, nullable: true, example: '10kg' })
  type!: string | null;
}

/** Una reserva pendiente de `GET /orders/reservations`. */
export class ReservaResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) customerPhone!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  scheduledDate!: string | null;
  @ApiProperty({ example: 'cash' }) paymentMethod!: string;
  @ApiProperty({ example: 22600 }) total!: number;
  @ApiProperty({ example: 5000 }) depositAmount!: number;
  @ApiProperty() depositPaid!: boolean;
  @ApiProperty({ example: 17600, description: 'Total menos la seña cobrada' })
  remainingBalance!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: RenglonDeReservaDto, isArray: true })
  items!: RenglonDeReservaDto[];
}

/** `POST /orders/:id/reject`: si había una oferta activa para ese chofer. */
export class RechazoDeOfertaResponseDto {
  @ApiProperty({
    description: 'false si el chofer no tenía una oferta activa del pedido',
  })
  rejected!: boolean;
}

/** `GET /orders/:id/delivery-code`: el código que el chofer muestra como QR. */
export class CodigoDeEntregaResponseDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'E498F43C8A' })
  deliveryCode!: string | null;
}
