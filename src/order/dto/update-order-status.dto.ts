import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../entities/order.entity';

/**
 * Body de `PATCH /orders/:id/status`. Valida que `status` sea un estado real del
 * pedido (rechaza con 400 claro antes de llegar a la máquina de estados) y que
 * `deliveryId`, si viene, sea un UUID. Reemplaza el tipo inline sin validación.
 *
 * Nota: para un chofer el controller IGNORA `deliveryId` y usa su identidad
 * autenticada; el campo solo lo usa el admin para asignar un chofer arbitrario.
 */
export class UpdateOrderStatusDto {
  @ApiProperty({
    description: 'Nuevo estado del pedido',
    enum: OrderStatus,
    example: OrderStatus.ACCEPTED,
  })
  @IsEnum(OrderStatus, {
    message: `status debe ser uno de: ${Object.values(OrderStatus).join(', ')}`,
  })
  status: OrderStatus;

  @ApiProperty({
    description: 'ID del repartidor (solo admin; el chofer usa su token)',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}
