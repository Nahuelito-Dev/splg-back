import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, MaxLength, MinLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import {
  MOTIVO_ENTREGA_MANUAL_MAX as MOTIVO_MAX,
  MOTIVO_ENTREGA_MANUAL_MIN as MOTIVO_MIN,
} from './update-order-status.dto';

/** Motivo de una acción manual de cobro: mismo criterio que la entrega manual. */
export const MOTIVO_DE_COBRO_MIN = MOTIVO_MIN;
export const MOTIVO_DE_COBRO_MAX = MOTIVO_MAX;

/**
 * Body de `PATCH /orders/:id/payment/register-cash` y
 * `PATCH /orders/:id/payment/register-unpaid`.
 */
export class MotivoDeCobroDto {
  @ApiProperty({
    minLength: MOTIVO_DE_COBRO_MIN,
    maxLength: MOTIVO_DE_COBRO_MAX,
    example: 'El chofer fue dado de baja antes de rendir el efectivo',
    description:
      'Por qué lo registra el administrador y no el chofer (10 a 500 caracteres). Queda en el pedido, en el historial de estados y en la auditoría.',
  })
  @TextoNoVacio()
  @MinLength(MOTIVO_DE_COBRO_MIN)
  @MaxLength(MOTIVO_DE_COBRO_MAX)
  reason!: string;
}

/** Body de `PATCH /orders/:id/payment/confirm-transfer`. */
export class ConfirmTransferDto extends MotivoDeCobroDto {
  @ApiProperty({
    example: true,
    description:
      '`true`: la transferencia llegó (el pago pasa a `paid` y el pedido cuenta como venta). `false`: no llegó (queda `failed`).',
  })
  @IsBoolean()
  received!: boolean;
}
