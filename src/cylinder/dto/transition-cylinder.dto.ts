import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { enMinusculas } from './en-minusculas';
import { CylinderState } from '../entities/cylinder.entity';

export class TransitionCylinderDto {
  @ApiProperty({ enum: CylinderState })
  @IsEnum(CylinderState)
  toState!: CylinderState;

  /**
   * Pedido en cuyo contexto ocurre la transición (ej. dispatch/entrega).
   * Obligatorio para `with_customer`: de ahí sale el titular del envase.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Pedido de la transición. Obligatorio para `with_customer` (400 si falta): ' +
      'de ahí sale el cliente titular. En `dispatched` queda como pedido del envase',
  })
  @IsOptional()
  @Transform(enMinusculas)
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
