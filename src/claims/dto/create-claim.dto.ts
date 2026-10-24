import { IsNotEmpty, IsUUID, MaxLength } from 'class-validator';
import {
  LARGO_DESCRIPCION,
  LARGO_MOTIVO_DE_RECLAMO,
} from '../../common/constants/largos-de-texto';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateClaimDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  orderId!: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty({ maxLength: LARGO_MOTIVO_DE_RECLAMO })
  @TextoNoVacio()
  @MaxLength(LARGO_MOTIVO_DE_RECLAMO)
  reason!: string;

  @ApiProperty({ maxLength: LARGO_DESCRIPCION })
  @TextoNoVacio()
  @MaxLength(LARGO_DESCRIPCION)
  description!: string;
}
