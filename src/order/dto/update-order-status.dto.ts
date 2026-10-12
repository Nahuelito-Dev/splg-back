import { Transform } from 'class-transformer';
import {
  ValidateIf,
  IsOptional,
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../entities/order.entity';
import { ESTADOS_DE_LA_RESPUESTA } from './query-orders.dto';

/** Largo mínimo del motivo de una entrega manual del administrador. */
export const MOTIVO_ENTREGA_MANUAL_MIN = 10;
export const MOTIVO_ENTREGA_MANUAL_MAX = 500;

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

  @ApiProperty({
    description:
      'Motivo de la entrega manual. Obligatorio (mínimo 10 caracteres) cuando un ' +
      'admin/super_admin pasa el pedido a `delivered`; queda en el historial de ' +
      'estados y en la auditoría. Se ignora en los demás estados.',
    required: false,
    minLength: MOTIVO_ENTREGA_MANUAL_MIN,
    maxLength: MOTIVO_ENTREGA_MANUAL_MAX,
    example: 'El cliente no tiene celular: confirmó la entrega por teléfono',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((o: UpdateOrderStatusDto) => o.status === OrderStatus.DELIVERED)
  @IsOptional()
  @IsString()
  @MaxLength(MOTIVO_ENTREGA_MANUAL_MAX)
  reason?: string;
}
