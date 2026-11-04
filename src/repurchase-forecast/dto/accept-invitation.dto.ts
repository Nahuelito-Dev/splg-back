import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaymentMethod } from '../../order/entities/order.entity';

/** Medios de pago que el cliente puede elegir al aceptar: la cuenta corriente la carga el administrador. */
export const MEDIOS_AL_ACEPTAR = [
  PaymentMethod.CASH,
  PaymentMethod.TRANSFER,
  PaymentMethod.MERCADOPAGO,
] as const;

/**
 * Lo que el cliente puede cambiar de la sugerencia al aceptarla. Sin cuerpo se
 * crea el pedido tal cual se ofreció, de entrega inmediata.
 */
export class AcceptInvitationDto {
  @ApiPropertyOptional({
    enum: MEDIOS_AL_ACEPTAR,
    description: 'Medio de pago; por omisión el de la invitación',
  })
  @IsOptional()
  @IsIn(MEDIOS_AL_ACEPTAR)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Franja horaria de la entrega. Va junto con `scheduledDate`; sin ninguna de las dos, la entrega es inmediata',
  })
  @IsOptional()
  @IsUUID()
  timeSlotId?: string;

  @ApiPropertyOptional({
    example: '2026-11-03',
    description: 'Día de la entrega (YYYY-MM-DD). Va junto con `timeSlotId`',
  })
  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
