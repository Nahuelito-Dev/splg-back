import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
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

/** Descripción común del campo `cashBoxId` de los cobros que entran a caja. */
export const CASH_BOX_ID_DESCRIPCION =
  'Caja de EFECTIVO donde entra lo cobrado. Obligatoria si la distribuidora tiene alguna caja de efectivo activa (400 si falta o si la caja no es de efectivo); la de otra distribuidora es 404 y una que exige sesión sin sesión abierta, 409. Se asienta una entrada por el saldo a cobrar (total menos la seña ya paga; si es 0 no se asienta), con categoría de sistema `order_payment`. Si la rendición del chofer ya tomó el pedido, 409.';

/** Body de `PATCH /orders/:id/payment/register-cash`. */
export class RegisterCashDto extends MotivoDeCobroDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: CASH_BOX_ID_DESCRIPCION,
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
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
