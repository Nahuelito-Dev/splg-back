import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../entities/order.entity';
import { ESTADOS_DE_LA_RESPUESTA } from './query-orders.dto';

/**
 * Body de `PATCH /orders/:id/status`. Valida que `status` sea un estado real del
 * pedido (rechaza con 400 claro antes de llegar a la máquina de estados) y que
 * `deliveryId`, si viene, sea un UUID. Reemplaza el tipo inline sin validación.
 *
 * Igual que el filtro de `GET /orders` (`query-orders.dto.ts`): acepta el
 * vocabulario de la RESPUESTA (`out_for_delivery`), no sólo el interno
 * (`on_the_way`), y lo mapea antes de validar.
 *
 * Nota: para un chofer el controller IGNORA `deliveryId` y usa su identidad
 * autenticada; el campo solo lo usa el admin para asignar un chofer arbitrario.
 */
export class UpdateOrderStatusDto {
  @ApiProperty({
    description:
      'Nuevo estado del pedido, con el vocabulario de la respuesta ' +
      '(`out_for_delivery` es el pedido en camino)',
    enum: ESTADOS_DE_LA_RESPUESTA,
    example: OrderStatus.ACCEPTED,
  })
  @Transform(({ value }: { value: unknown }) =>
    value === 'out_for_delivery' ? OrderStatus.ON_THE_WAY : value,
  )
  @IsEnum(OrderStatus, {
    message: `status debe ser uno de: ${Object.values(OrderStatus).join(', ')}`,
  })
  status!: OrderStatus;

  @ApiProperty({
    description: 'ID del repartidor (solo admin; el chofer usa su token)',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}
